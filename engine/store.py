# -*- coding: utf-8 -*-
"""界面配置的落盘与读取。

配置写在 ComfyUI 的用户目录里（`user/default/nodes_manager/ui.json`），
不写进插件目录 —— 插件目录随时会被 git pull / 重装覆盖，用户目录不会。

结构::

    {
      "version": 1,
      "global": {"scale": 1.0, "gap": 8, "fontSize": null, ...},
      "items": {
        "<稳定 id>": {
          "hidden": false,        # 是否隐藏
          "fontSize": 12,         # 文字字号 px；null = 不干预
          "iconSize": 16,         # 图标字号 px；null = 不干预
          "labelOnly": false,     # 只留文字（藏图标）
          "iconOnly": false,      # 只留图标（藏文字）
          "order": -1,            # flex order；null = 不干预
          "zone": "actionbar",    # 想搬到哪个区域；null = 留在原处
          "width": null           # 强制宽度 px；null = 由内容撑开
        }
      },
      "seen": {"<id>": {"first": 1756..., "label": "..."}},  # 界面条目：见过哪些
      "plugins": {"<插件目录名>": {"first": 1756..., "seen": 1756...}}  # 磁盘插件
    }

`seen` 由前端扫 DOM 得到（界面上的按钮/图标），`plugins` 由后端扫
custom_nodes 目录得到（磁盘上装了什么），两者都用来判断「这是不是新的」。
"""

import copy
import json
import os
import tempfile
import threading
import time

VERSION = 1

# 每个条目可调的字段与默认值。前端只提交这些键，其余一律丢掉。
ITEM_FIELDS = {
    "hidden": False,
    "fontSize": None,
    "iconSize": None,
    "labelOnly": False,
    "iconOnly": False,
    "order": None,
    "zone": None,
    "width": None,
    "note": "",
}

GLOBAL_FIELDS = {
    "enabled": True,        # 总开关，关掉后前端不写任何样式
    "scale": None,          # 整条等比缩放（zoom），None = 不干预
    "gap": None,            # 按钮间距 px
    "fontSize": None,       # 整条统一字号 px
    "iconSize": None,       # 整条统一图标字号 px
    "wrap": False,          # 允许按钮条折行
    "autoReveal": True,     # 新探测到的插件默认显示（False = 默认隐藏）
}

_LOCK = threading.RLock()
_CACHE = None
_CACHE_MTIME = None


def config_dir():
    """配置目录。

    优先级：环境变量 NODES_MANAGER_CONFIG_DIR > ComfyUI 用户目录 > 插件目录下的
    `_user`（只有脱离 ComfyUI 单跑时才会走到最后这个）。
    """
    env = os.environ.get("NODES_MANAGER_CONFIG_DIR")
    if env:
        return env
    try:
        import folder_paths
        base = folder_paths.get_user_directory()
    except Exception:
        base = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "_user")
    return os.path.join(base, "nodes_manager")


def config_path():
    return os.path.join(config_dir(), "ui.json")


def blank():
    """一份空配置。"""
    return {"version": VERSION, "global": dict(GLOBAL_FIELDS),
            "items": {}, "seen": {}, "plugins": {}}


def _coerce_num(val, lo, hi, allow_float=False):
    """把前端传来的数字夹到合理区间；非数字返回 None（= 不干预）。"""
    if val is None or val == "":
        return None
    try:
        num = float(val)
    except (TypeError, ValueError):
        return None
    if num != num or num in (float("inf"), float("-inf")):
        return None
    num = max(lo, min(hi, num))
    return round(num, 3) if allow_float else int(round(num))


def sanitize_item(raw):
    """把一条前端提交的条目配置洗成规范形状。"""
    out = dict(ITEM_FIELDS)
    if not isinstance(raw, dict):
        return out
    out["hidden"] = bool(raw.get("hidden"))
    out["labelOnly"] = bool(raw.get("labelOnly"))
    out["iconOnly"] = bool(raw.get("iconOnly"))
    out["fontSize"] = _coerce_num(raw.get("fontSize"), 4, 64)
    out["iconSize"] = _coerce_num(raw.get("iconSize"), 4, 64)
    out["width"] = _coerce_num(raw.get("width"), 0, 4000)
    out["order"] = _coerce_num(raw.get("order"), -999, 999)
    zone = raw.get("zone")
    out["zone"] = zone if isinstance(zone, str) and zone else None
    note = raw.get("note")
    out["note"] = note[:200] if isinstance(note, str) else ""
    # 只留图标与只留文字互斥，同时勾选按「只留图标」算
    if out["iconOnly"] and out["labelOnly"]:
        out["labelOnly"] = False
    return out


def sanitize_global(raw):
    out = dict(GLOBAL_FIELDS)
    if not isinstance(raw, dict):
        return out
    out["enabled"] = bool(raw.get("enabled", True))
    out["wrap"] = bool(raw.get("wrap"))
    out["autoReveal"] = bool(raw.get("autoReveal", True))
    out["scale"] = _coerce_num(raw.get("scale"), 0.3, 3, allow_float=True)
    out["gap"] = _coerce_num(raw.get("gap"), 0, 64)
    out["fontSize"] = _coerce_num(raw.get("fontSize"), 4, 64)
    out["iconSize"] = _coerce_num(raw.get("iconSize"), 4, 64)
    return out


def sanitize(raw):
    """整份配置的清洗；任何缺失/异常字段都退回默认值。"""
    cfg = blank()
    if not isinstance(raw, dict):
        return cfg
    cfg["global"] = sanitize_global(raw.get("global"))
    items = raw.get("items")
    if isinstance(items, dict):
        for key, val in items.items():
            if isinstance(key, str) and key:
                cfg["items"][key[:300]] = sanitize_item(val)
    seen = raw.get("seen")
    if isinstance(seen, dict):
        for key, val in seen.items():
            if not (isinstance(key, str) and key):
                continue
            rec = val if isinstance(val, dict) else {}
            first = _coerce_num(rec.get("first"), 0, 4e18)
            cfg["seen"][key[:300]] = {
                "first": first or int(time.time()),
                "label": str(rec.get("label", ""))[:120],
                "zone": str(rec.get("zone", ""))[:60],
            }
    plugins = raw.get("plugins")
    if isinstance(plugins, dict):
        for key, val in plugins.items():
            if not (isinstance(key, str) and key):
                continue
            rec = val if isinstance(val, dict) else {}
            first = _coerce_num(rec.get("first"), 0, 4e18)
            seen_at = _coerce_num(rec.get("seen"), 0, 4e18)
            cfg["plugins"][key[:300]] = {
                "first": first or int(time.time()),
                "seen": seen_at or first or int(time.time()),
                "disabled": bool(rec.get("disabled")),
                "web": str(rec.get("web", ""))[:20],
            }
    return cfg


def load(force=False):
    """读配置；文件 mtime 没变时走缓存（照 clothes 插件的做法）。"""
    global _CACHE, _CACHE_MTIME
    path = config_path()
    with _LOCK:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = None
        if not force and _CACHE is not None and mtime == _CACHE_MTIME:
            return copy.deepcopy(_CACHE)
        cfg = blank()
        if mtime is not None:
            try:
                with open(path, "r", encoding="utf-8") as fp:
                    cfg = sanitize(json.load(fp))
            except (OSError, ValueError) as err:
                print("[nodes-Manager] 配置读取失败，用默认值：%s" % err)
                cfg = blank()
        _CACHE, _CACHE_MTIME = copy.deepcopy(cfg), mtime
        return cfg


def save(cfg):
    """原子写入（先写临时文件再 replace），避免半截文件把配置弄坏。"""
    global _CACHE, _CACHE_MTIME
    cfg = sanitize(cfg)
    path = config_path()
    with _LOCK:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fp:
                json.dump(cfg, fp, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        _CACHE = copy.deepcopy(cfg)
        try:
            _CACHE_MTIME = os.path.getmtime(path)
        except OSError:
            _CACHE_MTIME = None
    return cfg


def merge_seen(cfg, found):
    """把本次探测到的条目并进 `seen`，返回新出现的 id 列表。

    `found` 是 `[{"id":..., "label":..., "zone":...}]`。新条目按
    `global.autoReveal` 决定要不要预置一条隐藏配置。
    """
    now = int(time.time())
    fresh = []
    seen = cfg.setdefault("seen", {})
    for rec in found or ():
        key = (rec or {}).get("id")
        if not isinstance(key, str) or not key:
            continue
        key = key[:300]
        if key in seen:
            # 标签可能因语言切换而变，顺手刷新
            seen[key]["label"] = str(rec.get("label", ""))[:120] or seen[key].get("label", "")
            continue
        seen[key] = {"first": now,
                     "label": str(rec.get("label", ""))[:120],
                     "zone": str(rec.get("zone", ""))[:60]}
        fresh.append(key)
        if not cfg["global"].get("autoReveal", True):
            # 结构性容器（区域根的直接子 div）不做预置隐藏 —— 藏它等于藏整片
            # 区域，实测侧栏滚动容器被预置隐藏后，总开关一开左侧栏整个消失。
            # 手动到面板里隐藏仍然允许，这里只拦「自动」。
            parts = key.split("|")
            structural = (any(p.startswith("g:div") for p in parts)
                          and any(p == "d:1" for p in parts))
            if not structural:
                item = cfg["items"].setdefault(key, dict(ITEM_FIELDS))
                item["hidden"] = True
    return fresh


def forget(cfg, keys):
    """删掉若干条目的配置与探测记录（插件卸载后清理用）。"""
    gone = []
    for key in keys or ():
        if not isinstance(key, str):
            continue
        if cfg.get("items", {}).pop(key, None) is not None:
            gone.append(key)
        cfg.get("seen", {}).pop(key, None)
    return gone
