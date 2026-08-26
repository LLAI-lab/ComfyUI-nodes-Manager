# -*- coding: utf-8 -*-
"""ComfyUI-nodes-Manager：管理插件往界面里塞的那些按钮。

自动探测装了哪些插件、界面上多了哪些按钮，并逐个调整字号 / 图标大小 /
显示隐藏 / 位置。配置存在用户目录，不改 ComfyUI 本体、不改别的插件。

这个插件不注册任何节点，只提供一个侧栏面板 + 一组配置接口。
"""

from .engine import routes, scan, store

WEB_DIRECTORY = "./web"

routes.register_routes()

_cfg = store.load()
_found = scan.scan()
_fresh, _gone, _dirty = scan.diff_new(_cfg, _found)
if _dirty:
    store.save(_cfg)

print("[nodes-Manager] 插件 %d 个" % len(_found), end="")
if _fresh:
    print("，新增 %d 个：%s" % (len(_fresh), "、".join(_fresh[:5])
                             + ("…" if len(_fresh) > 5 else "")), end="")
if _gone:
    print("，消失 %d 个" % len(_gone), end="")
print("，配置 %s" % store.config_path())

# 不注册节点，但 ComfyUI 要求这两个映射存在
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
