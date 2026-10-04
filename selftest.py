# -*- coding: utf-8 -*-
"""插件自检：`python selftest.py`（用 ComfyUI 自带的 python 跑即可）。

不需要 ComfyUI 在运行 —— 后端三个模块都能脱离 ComfyUI 单独用，
自检就跑在一个临时目录里，不碰真配置。

检查：
  * 配置清洗：非法值能不能被夹回合理区间
  * 存取回环：写进去的配置读出来一模一样
  * 原子写：不留 .tmp 残留
  * 插件扫描：能不能在 custom_nodes 里认出插件目录
  * 探测：新插件 / 新界面条目的判定
  * 前端文件：该有的都在，导出的符号对得上入口的 import

退出码 0 = 全部通过，1 = 有问题。
"""

import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

if hasattr(sys.stdout, "reconfigure"):          # Windows 控制台默认 GBK
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROBLEMS = []


def check(cond, msg):
    if not cond:
        PROBLEMS.append(msg)
    return cond


def load_pkg():
    """把插件目录当包加载，让 engine 里的相对导入能用。"""
    name = "comfyui_nodes_manager_selftest"
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(HERE, "__init__.py"), submodule_search_locations=[HERE])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return (sys.modules[name + ".engine.store"],
            sys.modules[name + ".engine.scan"],
            sys.modules[name + ".engine.routes"],
            sys.modules[name + ".engine.hotload"])


def test_sanitize(store):
    """越界值、错类型、脏 key 都要被收拾干净。"""
    dirty = {
        "global": {"scale": 99, "gap": -5, "fontSize": "abc", "iconSize": None,
                   "enabled": "yes", "wrap": 1, "autoReveal": 0},
        "items": {
            "z|a:x": {"hidden": 1, "fontSize": 999, "iconSize": -3,
                      "iconOnly": True, "labelOnly": True,
                      "order": "12", "width": 1e9, "zone": 5, "note": "x" * 500},
            "": {"hidden": True},                       # 空 key 要丢掉
            "z|b": "不是字典",                            # 错类型要退回默认
        },
        "seen": {"z|a:x": {"first": "坏值", "label": 123, "zone": None}},
        "plugins": {"Foo": {"first": 1, "seen": 2, "disabled": 1, "web": "web"}},
        "垃圾字段": [1, 2, 3],
    }
    cfg = store.sanitize(dirty)

    g = cfg["global"]
    check(g["scale"] == 3, "scale 应夹到上限 3，得到 %r" % g["scale"])
    check(g["gap"] == 0, "gap 应夹到下限 0，得到 %r" % g["gap"])
    check(g["fontSize"] is None, "非数字 fontSize 应变 None，得到 %r" % g["fontSize"])
    check(g["enabled"] is True and g["wrap"] is True, "布尔字段没规范化")
    check(g["autoReveal"] is False, "autoReveal=0 应为 False")

    it = cfg["items"]["z|a:x"]
    check(it["fontSize"] == 64, "fontSize 应夹到 64，得到 %r" % it["fontSize"])
    check(it["iconSize"] == 4, "iconSize 应夹到 4，得到 %r" % it["iconSize"])
    check(it["order"] == 12, "字符串 order 应转成数字，得到 %r" % it["order"])
    check(it["width"] == 4000, "width 应夹到 4000，得到 %r" % it["width"])
    check(it["zone"] is None, "非字符串 zone 应变 None，得到 %r" % it["zone"])
    check(len(it["note"]) <= 200, "note 应截断到 200 字")
    check(it["iconOnly"] and not it["labelOnly"], "两个都勾时应只保留 iconOnly")

    check("" not in cfg["items"], "空 key 应被丢掉")
    check(cfg["items"]["z|b"] == store.ITEM_FIELDS, "错类型条目应退回默认值")
    check("垃圾字段" not in cfg, "未知顶层字段应被丢掉")
    check(isinstance(cfg["seen"]["z|a:x"]["first"], int), "seen.first 应是整数")
    check(cfg["plugins"]["Foo"]["disabled"] is True, "plugins.disabled 应是布尔")


def test_roundtrip(store, tmp):
    """写进去再读出来必须一模一样，且不留临时文件。"""
    store.load(force=True)
    cfg = store.blank()
    cfg["global"]["scale"] = 0.85
    cfg["global"]["gap"] = 4
    cfg["items"]["actionbar|c:foo-bar"] = dict(store.ITEM_FIELDS, hidden=True, fontSize=11)
    saved = store.save(cfg)

    path = store.config_path()
    check(os.path.isfile(path), "配置文件没写出来：%s" % path)
    leftovers = [f for f in os.listdir(os.path.dirname(path)) if f.endswith(".tmp")]
    check(not leftovers, "原子写留下了临时文件：%r" % leftovers)

    again = store.load(force=True)
    check(again == saved, "存取回环不一致")
    check(again["global"]["scale"] == 0.85, "浮点 scale 没存住")
    check(again["items"]["actionbar|c:foo-bar"]["fontSize"] == 11, "条目配置没存住")

    with open(path, "r", encoding="utf-8") as fp:
        raw = json.load(fp)
    check(raw["version"] == store.VERSION, "落盘的 version 不对")


def test_seen(store):
    """merge_seen：第一次算新，第二次不算；autoReveal=False 时预置隐藏。"""
    cfg = store.blank()
    found = [{"id": "actionbar|t:按钮A", "label": "按钮A", "zone": "actionbar"},
             {"id": "rail|t:按钮B", "label": "按钮B", "zone": "rail"},
             {"id": "", "label": "空的"}]
    fresh = store.merge_seen(cfg, found)
    check(len(fresh) == 2, "首次应报 2 个新条目，得到 %r" % fresh)
    check(store.merge_seen(cfg, found) == [], "同一批条目第二次不该再算新")

    cfg2 = store.blank()
    cfg2["global"]["autoReveal"] = False
    store.merge_seen(cfg2, found)
    hidden = cfg2["items"]["actionbar|t:按钮A"]["hidden"]
    check(hidden is True, "autoReveal=False 时新条目应预置为隐藏")

    gone = store.forget(cfg, ["actionbar|t:按钮A"])
    check("actionbar|t:按钮A" not in cfg["seen"], "forget 应同时清掉 seen 记录")
    check(gone == [] or gone == ["actionbar|t:按钮A"], "forget 返回值不对：%r" % gone)


def test_hotload(hotload):
    """热加载：无 ComfyUI 环境下，守卫逻辑必须全部优雅拒绝。"""
    check(hotload.SELF_NAME == "ComfyUI-nodes-Manager", "SELF_NAME 判断不对：%r" % hotload.SELF_NAME)

    r = hotload.toggle("", True)
    check(not r["ok"] and "插件名" in r["msg"], "空名应拒绝：%r" % r)

    r = hotload.toggle("不存在-XYZ", True)
    check(not r["ok"] and "没有这个插件" in r["msg"], "未知插件应拒绝：%r" % r)

    r = hotload.toggle(hotload.SELF_NAME, False)
    check(not r["ok"] and "自身" in r["msg"], "停用自身应拒绝：%r" % r)

    # 真实存在的插件：环境里没有 ComfyUI 的 nodes 模块，动作要失败而不是崩
    r = hotload.toggle(hotload.SELF_NAME, True)
    check(isinstance(r, dict) and "ok" in r, "启用应返回结构化结果：%r" % r)
    hot_state = hotload.hot_state([hotload.SELF_NAME])
    check(hot_state[hotload.SELF_NAME]["loaded"] in (True, False), "hot_state 应返回布尔")


def test_hotload_roundtrip(hotload, scan, store, tmp):
    """假插件 + 假 nodes 模块，走一遍 停用→改名→启用→改回 的完整往返。"""
    import types

    root = os.path.join(tmp, "custom_nodes")
    plug = os.path.join(root, "FakePlug")
    os.makedirs(os.path.join(plug, "web"))
    with open(os.path.join(plug, "__init__.py"), "w", encoding="utf-8") as fp:
        fp.write(
            "NODE_CLASS_MAPPINGS = {'FakeNode': type('FakeNode', (), {})}\n"
            "NODE_DISPLAY_NAME_MAPPINGS = {'FakeNode': '假节点'}\n"
            "WEB_DIRECTORY = 'web'\n"
        )
    scan.custom_nodes_dirs = lambda: [root]

    comfy = types.SimpleNamespace(NODE_CLASS_MAPPINGS={}, NODE_DISPLAY_NAME_MAPPINGS={})
    sys.modules["nodes"] = comfy
    try:
        r = hotload.toggle("FakePlug", False)             # 停用（未导入 → 只改名）
        check(r["ok"], "停用应成功：%r" % r)
        check(os.path.isdir(plug + ".disabled"), "目录应改名为 .disabled")
        check(comfy.NODE_CLASS_MAPPINGS == {}, "未导入的插件应没有类可摘")

        r = hotload.toggle("FakePlug", True)              # 启用（现场导入 + 注册）
        check(r["ok"], "启用应成功：%r" % r)
        check(os.path.isdir(plug) and not os.path.isdir(plug + ".disabled"), "目录应改回原名")
        check("FakeNode" in comfy.NODE_CLASS_MAPPINGS, "节点类应注册进全局映射")
        check(comfy.NODE_DISPLAY_NAME_MAPPINGS.get("FakeNode") == "假节点", "显示名应注册")
        check(r["msg"], "启用消息不能为空")

        # 已导入后再停用：应摘类 + 改名；再启用：应放回类
        r = hotload.toggle("FakePlug", False)
        check(r["ok"] and r.get("stripped") == 1, "再停用应摘掉 1 个类：%r" % r)
        check("FakeNode" not in comfy.NODE_CLASS_MAPPINGS, "停用后类应从全局映射消失")
        check(os.path.isdir(plug + ".disabled"), "再停用目录应改名")
        r = hotload.toggle("FakePlug", True)
        check(r["ok"] and "放回" in r["msg"], "再启用应走恢复路径：%r" % r)
        check(comfy.NODE_CLASS_MAPPINGS.get("FakeNode") is not None, "恢复后类应回到映射")
    finally:
        sys.modules.pop("nodes", None)
        hotload._RUNTIME.pop("FakePlug", None)
        scan.custom_nodes_dirs = scan.__dict__.get("_orig_dirs", scan.custom_nodes_dirs)
        store.load(force=True)


def test_scan(scan):
    """扫描要能在真的 custom_nodes 里认出插件，并认出自己。"""
    found = scan.scan()
    check(found, "一个插件都没扫到（custom_nodes 路径没找对？）")
    names = [r["name"] for r in found]
    check("ComfyUI-nodes-Manager" in names, "没扫到自己，应该出现在结果里")
    check(len(names) == len(set(names)), "扫描结果里有重名")
    for rec in found[:50]:
        check(os.path.isdir(rec["path"]), "path 不是目录：%r" % rec["path"])
    print("    扫到插件 %d 个" % len(found))

    # 首次运行不该报新增，但基线必须要求落盘（dirty=True），
    # 否则下次进来又是「首次」，永远报不出新插件
    cfg = {"plugins": {}}
    fresh, gone, dirty = scan.diff_new(cfg, found)
    check(fresh == [], "首次运行不该报新插件，得到 %d 个" % len(fresh))
    check(dirty is True, "首次运行必须要求落盘基线")
    check(len(cfg["plugins"]) == len(found), "基线应记下全部插件")

    fake = found + [{"name": "ZZ-假插件", "path": HERE, "disabled": False,
                     "web": "", "mtime": 0}]
    fresh2, _, dirty2 = scan.diff_new(cfg, fake)
    check(fresh2 == ["ZZ-假插件"], "第二次应只报那个假插件，得到 %r" % fresh2)
    check(dirty2 is True, "有新增时应要求落盘")

    _, gone2, _ = scan.diff_new(cfg, found)
    check(gone2 == ["ZZ-假插件"], "假插件消失后应报消失，得到 %r" % gone2)
    # 消失的要从记录里删掉，只报一次；否则每次扫都报同一批
    _, gone3, dirty3 = scan.diff_new(cfg, found)
    check(gone3 == [], "消失的插件不该反复上报，得到 %r" % gone3)
    check(dirty3 is False, "没有结构变化时不该要求落盘")


def test_web():
    """前端文件齐不齐，入口 import 的符号是否真的被导出。"""
    web = os.path.join(HERE, "web")
    need = ["nodes_manager.js", "nm_panel.js", "nm_style.js", "nm_zones.js", "nm_entry.js"]
    for name in need:
        check(os.path.isfile(os.path.join(web, name)), "缺前端文件 %s" % name)

    src = {}
    for name in need:
        path = os.path.join(web, name)
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fp:
                src[name] = fp.read()

    entry = src.get("nodes_manager.js", "")
    # 入口 import 的本地符号，逐个回查对应文件有没有导出
    for m in re.finditer(r'import\s*\{([^}]+)\}\s*from\s*"\.\/(nm_[a-z_]+\.js)"', entry):
        syms = [s.strip() for s in m.group(1).split(",") if s.strip()]
        target = src.get(m.group(2), "")
        for sym in syms:
            check(re.search(r'export\s+(?:const|function|class|let)\s+%s\b' % re.escape(sym), target)
                  or re.search(r'export\s*\{[^}]*\b%s\b' % re.escape(sym), target),
                  "%s 没有导出 %s（入口 import 了它）" % (m.group(2), sym))

    # 入口必须能拿到 app / api
    check('from "../../scripts/app.js"' in entry, "入口没 import app")
    check('from "../../scripts/api.js"' in entry, "入口没 import api")
    # 后端路由前缀要一致
    for path in ["/nodes_manager/state", "/nodes_manager/seen"]:
        check(path in entry or path in src.get("nm_panel.js", ""),
              "前端没用到路由 %s" % path)


def main():
    # 必须在加载插件包**之前**把配置目录指到临时目录 —— __init__.py 在导入时
    # 就会写基线，晚一步就会在插件目录里留下 _user/。
    tmp = tempfile.mkdtemp(prefix="nm-selftest-")
    os.environ["NODES_MANAGER_CONFIG_DIR"] = os.path.join(tmp, "nodes_manager")

    store, scan, routes, hotload = load_pkg()
    check(store.config_path().startswith(tmp),
          "配置目录没指到临时目录：%s" % store.config_path())

    try:
        print("[1/6] 配置清洗")
        test_sanitize(store)
        print("[2/6] 存取回环")
        test_roundtrip(store, tmp)
        print("[3/6] 探测记录")
        test_seen(store)
        print("[4/6] 插件扫描")
        test_scan(scan)
        print("[5/6] 热加载")
        test_hotload(hotload)
        test_hotload_roundtrip(hotload, scan, store, tmp)
        print("[6/6] 前端文件")
        test_web()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        os.environ.pop("NODES_MANAGER_CONFIG_DIR", None)
        # 万一有哪次跑漏了环境变量，把插件目录里的残留一起清掉
        stray = os.path.join(HERE, "_user")
        if os.path.isdir(stray):
            shutil.rmtree(stray, ignore_errors=True)

    if PROBLEMS:
        print("\n发现 %d 处问题：" % len(PROBLEMS))
        for p in PROBLEMS:
            print("  - %s" % p)
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
