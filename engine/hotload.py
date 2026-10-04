# -*- coding: utf-8 -*-
"""custom_nodes 热加载：不重启 ComfyUI 地停用 / 启用插件。

三层动作，按情况组合：

* **软停用**：插件已导入时，把它的 NODE_CLASS_MAPPINGS 从 ComfyUI 的
  `nodes.NODE_CLASS_MAPPINGS` 里摘掉 —— 节点立即从菜单/新建搜索消失。
  保留模块对象与摘下的类的引用，恢复时原样放回。
  前端 JS 与已注册的 HTTP 接口无法卸载（进程内），本次会话仍保留。
* **改名持久化**：目录改成 `<名>.disabled` —— 与 ComfyUI-Manager 同一约定，
  重启后 ComfyUI 自己就不会加载它；`scan.py` 也认这个后缀。
* **热启用**：目录改回原名；模块还在内存里就放回类映射，没导入过就现场
  导入并注册（顺带补挂 `/extensions/<名>` 的静态目录，前端 JS 要刷新页面
  才会加载）。

不做的事（做不到或没意义）：卸载已执行过的 init 副作用；撤回已经注册的
aiohttp 路由；停用正在执行队列里的节点 —— 之后提交的、用到这些节点的
工作流会报「节点不存在」。
"""

import importlib.util
import os
import sys

# 进程内被软停用的插件：name -> {"classes": {...}, "display": {...}}
_RUNTIME = {}

SELF_NAME = os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def hot_state(names):
    """面板展示用的运行时状态：插件是否已导入 / 是否被软停用。"""
    out = {}
    for n in names:
        out[n] = {"loaded": n in sys.modules, "stripped": n in _RUNTIME}
    return out


def _comfy_nodes():
    import nodes as comfy_nodes
    return comfy_nodes


def _strip(name):
    """把已导入插件的节点类从全局映射摘掉，返回摘掉的个数。"""
    module = sys.modules.get(name)
    classes = getattr(module, "NODE_CLASS_MAPPINGS", {}) or {}
    display = getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {}
    comfy = _comfy_nodes()
    removed_c, removed_d = {}, {}
    for key in list(classes):
        # 只摘真的是它注册的那份，别误伤同名的（先注册者优先的约定）
        if comfy.NODE_CLASS_MAPPINGS.get(key) is classes[key]:
            removed_c[key] = comfy.NODE_CLASS_MAPPINGS.pop(key)
    for key in list(display):
        if key in comfy.NODE_DISPLAY_NAME_MAPPINGS:
            removed_d[key] = comfy.NODE_DISPLAY_NAME_MAPPINGS.pop(key)
    _RUNTIME[name] = {"classes": removed_c, "display": removed_d}
    return len(removed_c)


def _restore(name):
    """把软停用摘掉的类放回全局映射，返回放回的个数。"""
    rec = _RUNTIME.pop(name, None)
    if not rec:
        return 0
    comfy = _comfy_nodes()
    added = 0
    for key, obj in rec["classes"].items():
        if key not in comfy.NODE_CLASS_MAPPINGS:
            comfy.NODE_CLASS_MAPPINGS[key] = obj
            added += 1
    for key, obj in rec["display"].items():
        comfy.NODE_DISPLAY_NAME_MAPPINGS.setdefault(key, obj)
    return added


def _register_web(module_path, name):
    """给热启用的插件补挂前端静态目录（正常装载是启动时挂的）。"""
    module = sys.modules.get(name)
    web = getattr(module, "WEB_DIRECTORY", None)
    if not (isinstance(web, str) and web):
        return False
    web_path = os.path.join(module_path, web)
    if not os.path.isdir(web_path):
        return False
    try:
        from aiohttp import web as aioweb
        from server import PromptServer
        inst = getattr(PromptServer, "instance", None)
        if inst is None:
            return False
        inst.app.add_routes([aioweb.static("/extensions/" + name, web_path)])
        return True
    except Exception:
        return False


def _import_full(module_path, name):
    """完整导入一个未加载的插件目录并注册节点类（复刻 ComfyUI 装载要点）。"""
    init = os.path.join(module_path, "__init__.py")
    if not os.path.isfile(init):
        return {"ok": False, "msg": "目录里没有 __init__.py，只能重启加载"}
    comfy = _comfy_nodes()
    spec = importlib.util.spec_from_file_location(name, init)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as err:
        sys.modules.pop(name, None)
        return {"ok": False, "msg": "导入失败：%s" % err}

    added, skipped = 0, []
    for key, obj in (getattr(module, "NODE_CLASS_MAPPINGS", {}) or {}).items():
        if key in comfy.NODE_CLASS_MAPPINGS:
            skipped.append(key)
            continue
        comfy.NODE_CLASS_MAPPINGS[key] = obj
        added += 1
    for key, obj in (getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {}).items():
        comfy.NODE_DISPLAY_NAME_MAPPINGS.setdefault(key, obj)
    web = _register_web(module_path, name)
    return {"ok": True, "added": added, "skipped": skipped, "web": web}


def _find_dirs(name):
    """在 custom_nodes 各搜索路径里找启用版/停用版目录。

    启用路径即使还不存在（只 renamed 成 .disabled）也返回候选 —— 改回原名时要用。
    """
    from . import scan
    roots = scan.custom_nodes_dirs()
    candidates = [(os.path.join(r, name), os.path.join(r, name) + ".disabled") for r in roots]
    enabled = next((en for en, _ in candidates if os.path.isdir(en)),
                   candidates[0][0] if candidates else None)
    disabled = next((dis for _, dis in candidates if os.path.isdir(dis)), None)
    return enabled, disabled


def toggle(name, enable):
    """停用 / 启用一个插件。返回 {ok, msg, ...}；面板直接展示 msg。"""
    from . import scan, store

    name = str(name or "").strip()
    if not name:
        return {"ok": False, "msg": "缺少插件名"}
    if name == SELF_NAME:
        return {"ok": False, "msg": "不能停用本插件自身（界面管理）"}
    found = {r["name"]: r for r in scan.scan()}
    rec = found.get(name)
    if rec is None:
        return {"ok": False, "msg": "custom_nodes 里没有这个插件：%s" % name}

    cfg = store.load()
    rec_cfg = cfg["plugins"].setdefault(name, {})

    if enable:
        enabled_dir, disabled_dir = _find_dirs(name)
        if disabled_dir and enabled_dir and not os.path.isdir(enabled_dir):
            try:
                os.rename(disabled_dir, enabled_dir)
            except OSError as err:
                return {"ok": False, "msg": "目录改名失败（可能被占用）：%s" % err}
        if name in _RUNTIME:
            n = _restore(name)
            msg = "已恢复：%d 个节点类放回" % n
        elif name in sys.modules:
            msg = "模块本就处于载入状态，无需恢复"
        else:
            res = _import_full(enabled_dir or rec["path"], name)
            if not res["ok"]:
                return res
            msg = "已热载入：注册 %d 个节点类" % res["added"]
            if res["skipped"]:
                msg += "，%d 个重名跳过" % len(res["skipped"])
            if res["web"]:
                msg += "；前端 JS 刷新页面后生效"
        rec_cfg["disabled"] = False
        store.save(cfg)
        return {"ok": True, "msg": msg}

    # ---- 停用 ----
    enabled_dir, _ = _find_dirs(name)
    if not enabled_dir:
        return {"ok": False, "msg": "这个插件已经处于停用状态"}
    stripped = 0
    if name in sys.modules:
        stripped = _strip(name)
    renamed, err = False, None
    try:
        os.rename(enabled_dir, enabled_dir + ".disabled")
        renamed = True
    except OSError as e:
        err = e
    rec_cfg["disabled"] = True
    store.save(cfg)
    msg = []
    if stripped:
        msg.append("已移除 %d 个节点类（立即生效）" % stripped)
    else:
        msg.append("模块未导入或没有节点类")
    if renamed:
        msg.append("目录已改名 .disabled，重启后保持停用")
    else:
        msg.append("目录改名失败（%s），仅本次会话停用" % err)
    msg.append("它的前端脚本与 HTTP 接口本次会话仍保留")
    return {"ok": True, "msg": "；".join(msg), "stripped": stripped, "renamed": renamed}
