# -*- coding: utf-8 -*-
"""扫描 custom_nodes 目录，探测「装了哪些插件、哪些是新的」。

这是探测的**后端一半**：只看磁盘，回答「装了什么」。
界面上那些按钮长什么样、在哪个区域，磁盘上看不出来，
由前端 `web/nodes_manager.js` 扫运行时 DOM 回答，两边在面板里合并显示。

新插件的判定靠 `store` 里的 `plugins` 记录：这次扫到、上次没有 → 新。
第一次运行时全部记为已知（否则 500 个插件会一起冒出来说是新的）。
"""

import os
import time

# 这些目录名不是插件
SKIP_DIRS = frozenset(["__pycache__", ".git", ".github", ".idea", ".vscode",
                       "node_modules", "example_workflows", "examples"])
SKIP_PREFIX = ("__", ".")

# 判定「这是一个 ComfyUI 插件目录」的标志文件
MARKERS = ("__init__.py", "pyproject.toml", "install.py")


def custom_nodes_dirs():
    """custom_nodes 的搜索路径，优先问 ComfyUI 自己。"""
    try:
        import folder_paths
        dirs = list(folder_paths.get_folder_paths("custom_nodes"))
        if dirs:
            return dirs
    except Exception:
        pass
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return [os.path.dirname(here)]


def _is_plugin(path):
    for name in MARKERS:
        if os.path.isfile(os.path.join(path, name)):
            return True
    return False


def _web_dir(path):
    """插件的前端目录（有的话），顺带说明它会不会往界面里塞东西。"""
    for name in ("web", "js", "dist"):
        cand = os.path.join(path, name)
        if os.path.isdir(cand):
            return name
    return ""


def scan():
    """返回 `[{name, path, disabled, web, mtime}]`，按名字排序。"""
    out = {}
    for root in custom_nodes_dirs():
        try:
            entries = sorted(os.listdir(root))
        except OSError:
            continue
        for name in entries:
            path = os.path.join(root, name)
            if not os.path.isdir(path):
                continue
            if name in SKIP_DIRS or name.startswith(SKIP_PREFIX):
                continue
            # ComfyUI-Manager 停用插件的做法是给目录名加 .disabled 后缀
            disabled = name.endswith(".disabled")
            key = name[: -len(".disabled")] if disabled else name
            if not _is_plugin(path):
                continue
            try:
                mtime = int(os.path.getmtime(path))
            except OSError:
                mtime = 0
            rec = {"name": key, "path": path, "disabled": disabled,
                   "web": _web_dir(path), "mtime": mtime}
            # 同名的启用版优先于 .disabled 版
            if key not in out or not disabled:
                out[key] = rec
    return [out[k] for k in sorted(out)]


def diff_new(cfg, found):
    """把这次扫到的插件并进 `cfg['plugins']`，返回 (新增, 消失, 要不要落盘)。

    首次运行（记录为空）时不报新增，只是把现状记下来 —— 否则 500 个插件
    会一起冒出来说是新的。但这份基线**必须落盘**，不然下次进来又是「首次」，
    永远报不出新插件。第三个返回值就是干这个的。

    消失的插件从记录里删掉，只报一次；重新装回来会重新算「新增」。
    """
    known = cfg.setdefault("plugins", {})
    first_run = not known
    now = int(time.time())
    names = set()
    fresh = []
    for rec in found:
        name = rec["name"]
        names.add(name)
        if name in known:
            known[name]["disabled"] = rec["disabled"]
            known[name]["seen"] = now
            continue
        known[name] = {"first": now, "seen": now,
                       "disabled": rec["disabled"], "web": rec["web"]}
        if not first_run:
            fresh.append(name)
    gone = sorted(n for n in known if n not in names)
    for name in gone:
        known.pop(name, None)
    # seen 时间戳每次扫都会变，但那不值得每次都写盘；只有结构变化才落盘
    dirty = bool(first_run or fresh or gone)
    return fresh, gone, dirty
