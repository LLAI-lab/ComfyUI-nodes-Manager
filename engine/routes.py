# -*- coding: utf-8 -*-
"""给前端面板提供的 HTTP 接口。

    GET  /nodes_manager/state          读配置 + 磁盘插件清单 + 新插件
    POST /nodes_manager/config         整份写回（前端面板「保存」）
    POST /nodes_manager/seen           前端报告本次扫到的界面条目，回新增的 id
    POST /nodes_manager/forget         删掉若干条目的配置
    GET  /nodes_manager/css            把配置渲染成 CSS 文本（调试用，前端直接注入）

写接口只接受本机请求之外的一切都由 ComfyUI 自己的 server 管；这里不额外加鉴权，
和 ComfyUI 其它插件的接口一致 —— 注意这意味着能访问 ComfyUI 的人就能改界面配置。
"""

from . import scan, store

_DONE = False


def state_payload():
    """面板首屏需要的全部数据。"""
    cfg = store.load()
    found = scan.scan()
    fresh, gone, dirty = scan.diff_new(cfg, found)
    if dirty:
        # 基线/变动都要落盘，否则下次进来又当「首次运行」，永远报不出新插件
        cfg = store.save(cfg)
    return {
        "version": store.VERSION,
        "config": cfg,
        "plugins": found,
        "newPlugins": fresh,
        "gonePlugins": gone,
        "itemFields": store.ITEM_FIELDS,
        "globalFields": store.GLOBAL_FIELDS,
        "configPath": store.config_path(),
    }


def register_routes():
    """挂接口；ComfyUI 没起 server（比如自检脚本里）时安静跳过。"""
    global _DONE
    if _DONE:
        return
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return

    async def _json_body(request):
        try:
            body = await request.json()
        except Exception:
            return None
        return body if isinstance(body, dict) else None

    @instance.routes.get("/nodes_manager/state")
    async def _nm_state(request):
        return web.json_response(state_payload())

    @instance.routes.post("/nodes_manager/config")
    async def _nm_config(request):
        body = await _json_body(request)
        if body is None:
            return web.json_response({"error": "需要 JSON 对象"}, status=400)
        cfg = store.load()
        # 前端只提交 global / items，plugins 与 seen 是探测记录，保留原值
        incoming = body.get("config") if "config" in body else body
        if not isinstance(incoming, dict):
            return web.json_response({"error": "config 需要是对象"}, status=400)
        merged = dict(cfg)
        if "global" in incoming:
            merged["global"] = incoming["global"]
        if "items" in incoming:
            merged["items"] = incoming["items"]
        saved = store.save(merged)
        return web.json_response({"ok": True, "config": saved})

    @instance.routes.post("/nodes_manager/seen")
    async def _nm_seen(request):
        body = await _json_body(request)
        if body is None:
            return web.json_response({"error": "需要 JSON 对象"}, status=400)
        cfg = store.load()
        fresh = store.merge_seen(cfg, body.get("found"))
        if fresh:
            cfg = store.save(cfg)
        return web.json_response({"ok": True, "new": fresh, "config": cfg})

    @instance.routes.post("/nodes_manager/forget")
    async def _nm_forget(request):
        body = await _json_body(request)
        if body is None:
            return web.json_response({"error": "需要 JSON 对象"}, status=400)
        cfg = store.load()
        gone = store.forget(cfg, body.get("ids"))
        cfg = store.save(cfg)
        return web.json_response({"ok": True, "removed": gone, "config": cfg})

    _DONE = True
