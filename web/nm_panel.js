// 侧栏面板：把扫描结果列出来，逐条调整，改完立即生效。
//
// 用原生 DOM 手搓，不引 Vue/React —— 这个插件只有一个面板，
// 引框架不划算，而且 ComfyUI 的 Vue 实例不对扩展开放。
//
// 交互约定：
//   * 改动即刻应用到页面（改 <style> 的 textContent，立即重排），但只在内存里；
//   * 「保存」才落盘到 user/default/nodes_manager/ui.json；
//   * 「撤销改动」重新拉一次配置，回到上次保存的状态。

import { scanUI, toPayload, ZONE_BY_ID, pickWidgetRoot, buildSelector } from "./nm_zones.js";
import { applyCSS, highlight, markAll, renderCSS } from "./nm_style.js";

const API = {
  state: "/nodes_manager/state",
  config: "/nodes_manager/config",
  seen: "/nodes_manager/seen",
  forget: "/nodes_manager/forget",
  pluginToggle: "/nodes_manager/plugin_toggle",
};

// 条目默认配置，和后端 store.ITEM_FIELDS 对齐
const ITEM_DEFAULT = {
  hidden: false, fontSize: null, iconSize: null,
  labelOnly: false, iconOnly: false, order: null, zone: null, width: null, note: "",
};

export class Panel {
  constructor(api) {
    this.api = api;           // ComfyUI 的 api 对象，用它发请求（自带 base 前缀与鉴权头）
    this.cfg = null;          // 当前配置（内存态，可能未保存）
    this.saved = null;        // 上次保存的配置，用来判断「有未保存改动」
    this.scan = null;         // 最近一次扫描结果
    this.newPlugins = [];     // 后端报告的新插件
    this.plugins = [];        // 磁盘插件清单
    this.hot = {};            // 插件运行时热载状态 {name: {loaded, stripped}}
    this.pluginFilter = "";
    this.filter = "";
    this.onlyChanged = false;
    this.root = null;
    this.dirty = false;
  }

  // ---------- 数据 ----------

  async fetchJSON(path, body, extra) {
    let opts = extra || {};
    if (body !== undefined) {
      opts = { ...opts, method: "POST", body: JSON.stringify(body),
               headers: { "Content-Type": "application/json", ...(opts.headers || {}) } };
    }
    const res = await this.api.fetchApi(path, opts);
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }

  async load() {
    // no-store：防止读到浏览器缓存的旧配置（总开关状态会因此「回退」）
    const state = await this.fetchJSON(API.state, undefined, { cache: "no-store" });
    this.cfg = state.config;
    this.saved = JSON.parse(JSON.stringify(state.config));
    this.newPlugins = state.newPlugins || [];
    this.plugins = state.plugins || [];
    this.hot = state.hot || {};
    this.configPath = state.configPath || "";
    this.dirty = false;
  }

  // 只刷新插件清单与热载状态，不动 this.cfg —— 不丢面板里未保存的调整
  async refreshMeta() {
    const state = await this.fetchJSON(API.state, undefined, { cache: "no-store" });
    this.plugins = state.plugins || [];
    this.hot = state.hot || {};
    this.newPlugins = state.newPlugins || [];
    for (const [k, v] of Object.entries(state.config.items || {})) {
      if (!this.cfg.items[k]) this.cfg.items[k] = v;
    }
  }

  // 扫 DOM，打标，把新条目报给后端
  async rescan() {
    // knownKeys：配置里已有的 key。文字漂移的元素（监控条）按基底沿用旧身份，
    // 否则每漂一次就生成一个新条目，隐藏规则追不上（闪烁的根源之一）。
    this.scan = scanUI({
      knownKeys: Object.keys(this.cfg.items || {}),
      customZones: (this.cfg.zones || []).map((z) => ({ zoneId: "u:" + z.id, label: z.label, root: z.root })),
    });
    markAll(this.scan.items);
    this.apply();
    try {
      const res = await this.fetchJSON(API.seen, { found: toPayload(this.scan.items) });
      // 后端可能因 autoReveal=false 给新条目预置了 hidden，合并回来
      if (res.config) {
        for (const [k, v] of Object.entries(res.config.items || {})) {
          if (!this.cfg.items[k]) this.cfg.items[k] = v;
        }
        this.freshItems = res.new || [];
      }
    } catch (err) {
      console.warn("[nodes-Manager] 上报扫描结果失败（不影响本地调整）", err);
    }
    this.apply();
  }

  itemConf(key) {
    if (!this.cfg.items[key]) this.cfg.items[key] = { ...ITEM_DEFAULT };
    return this.cfg.items[key];
  }

  isChanged(key) {
    const c = this.cfg.items[key];
    if (!c) return false;
    return Object.keys(ITEM_DEFAULT).some((k) => {
      const a = c[k], b = ITEM_DEFAULT[k];
      return !(a === b || (a == null && b == null) || (a === "" && b === ""));
    });
  }

  // 把当前配置渲染成 CSS 注入页面
  apply() {
    const zonesById = {};
    for (const [id, z] of Object.entries(ZONE_BY_ID)) zonesById[id] = { root: z.root };
    for (const z of this.cfg.zones || []) zonesById["u:" + z.id] = { root: z.root };
    applyCSS(renderCSS(this.cfg, zonesById));
    // 通知入口模块换了配置对象。不通知的话，入口那边的定时补扫会拿旧配置
    // 重新渲染 CSS，把面板里的预览覆盖掉（save/revert 会整体换掉 this.cfg，
    // 引用对不上，光靠共享同一个对象不够）。
    this.onApply?.(this.cfg);
  }

  touch() {
    this.dirty = true;
    this.apply();
    this.refreshHeader();
  }

  async save() {
    const res = await this.fetchJSON(API.config, {
      config: { global: this.cfg.global, items: this.cfg.items, zones: this.cfg.zones || [] },
    });
    this.cfg = res.config;
    this.saved = JSON.parse(JSON.stringify(res.config));
    this.dirty = false;
    this.apply();
    this.render();
  }

  async revert() {
    await this.load();
    this.apply();
    this.render();
  }

  // ---------- 视图 ----------

  mount(container) {
    this.root = document.createElement("div");
    this.root.setAttribute("data-nm-self", "1");
    this.root.className = "nm-panel";
    container.appendChild(this.root);
    this.injectPanelCSS();
    this.root.textContent = "读取中…";
    this.boot();
  }

  async boot() {
    try {
      await this.load();
      await this.rescan();
      this.render();
    } catch (err) {
      this.root.textContent = "";
      const box = el("div", "nm-err", `加载失败：${err.message}`);
      this.root.appendChild(box);
      console.error("[nodes-Manager] 面板加载失败", err);
    }
  }

  // 面板自己的样式。带 data-nm-self，扫描时会跳过，不会自己管自己。
  injectPanelCSS() {
    if (document.getElementById("nm-panel-css")) return;
    const st = document.createElement("style");
    st.id = "nm-panel-css";
    st.setAttribute("data-nm-self", "1");
    st.textContent = `
.nm-panel{display:flex;flex-direction:column;gap:8px;padding:8px;height:100%;overflow:auto;font-size:12px}
.nm-panel .nm-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.nm-panel button{cursor:pointer;padding:3px 8px;border-radius:4px;border:1px solid var(--border-color,#444);background:var(--comfy-input-bg,#222);color:inherit;font-size:12px}
.nm-panel button:hover{filter:brightness(1.25)}
.nm-panel button.nm-primary{border-color:#2563eb}
.nm-panel input[type=text],.nm-panel input[type=number],.nm-panel select{background:var(--comfy-input-bg,#222);color:inherit;border:1px solid var(--border-color,#444);border-radius:4px;padding:2px 4px;font-size:12px}
.nm-panel input[type=number]{width:52px}
.nm-panel .nm-zone{border:1px solid var(--border-color,#3a3a3a);border-radius:6px;overflow:hidden}
.nm-panel .nm-zone > summary{cursor:pointer;padding:5px 8px;background:rgba(255,255,255,.04);user-select:none}
.nm-panel .nm-zone[data-absent] > summary{opacity:.45}
.nm-panel .nm-item{border-top:1px solid var(--border-color,#333);padding:5px 8px}
.nm-panel .nm-item:hover{background:rgba(255,255,255,.05)}
.nm-panel .nm-item.nm-on{border-left:3px solid #f59e0b}
.nm-panel .nm-name{font-weight:600;word-break:break-all}
.nm-panel .nm-meta{opacity:.55;font-size:11px;margin-top:1px}
.nm-panel .nm-ctl{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:4px}
.nm-panel label{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.nm-panel .nm-err{color:#f87171;padding:8px;line-height:1.5}
.nm-panel .nm-tip{opacity:.6;line-height:1.5}
.nm-panel .nm-badge{background:#2563eb;color:#fff;border-radius:8px;padding:0 5px;font-size:10px}
.nm-panel .nm-badge.nm-warn{background:#b45309}
.nm-panel .nm-sticky{position:sticky;top:0;z-index:2;background:var(--comfy-menu-bg,#1e1e1e);padding-bottom:6px;border-bottom:1px solid var(--border-color,#333)}
.nm-panel .nm-plug-list{max-height:280px;overflow:auto}
.nm-panel .nm-plug-row{display:flex;align-items:center;gap:6px;padding:3px 8px;border-top:1px solid var(--border-color,#2c2c2c)}
.nm-panel .nm-plug-row:hover{background:rgba(255,255,255,.05)}
.nm-panel .nm-plug-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nm-panel button.nm-danger{border-color:#b91c1c}
`;
    document.head.appendChild(st);
  }

  refreshHeader() {
    const tag = this.root?.querySelector("[data-nm-dirty]");
    if (tag) tag.textContent = this.dirty ? "有未保存改动" : "";
  }

  render() {
    if (!this.root) return;
    this.root.textContent = "";
    this.root.appendChild(this.header());
    if (this.newPlugins.length) this.root.appendChild(this.newPluginsBox());
    this.root.appendChild(this.globalBox());
    this.root.appendChild(this.zonesBox());
    this.root.appendChild(this.pluginsBox());
    for (const zone of this.scan?.zones || []) {
      this.root.appendChild(this.zoneBox(zone));
    }
    this.root.appendChild(el("div", "nm-tip",
      `配置文件：${this.configPath}\n磁盘插件 ${this.plugins?.length || 0} 个。`));
  }

  header() {
    const box = el("div", "nm-sticky");
    const row = el("div", "nm-row");

    const save = btn("保存", () => this.save().catch((e) => alert(`保存失败：${e.message}`)));
    save.classList.add("nm-primary");
    const revert = btn("撤销改动", () => this.revert());
    const rescan = btn("重新扫描", () => this.rescan().then(() => this.render()));

    const dirty = el("span", "nm-badge nm-warn");
    dirty.setAttribute("data-nm-dirty", "1");
    dirty.textContent = this.dirty ? "有未保存改动" : "";

    row.append(save, revert, rescan, dirty);
    box.appendChild(row);

    const row2 = el("div", "nm-row");
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "搜索按钮名 / 类名";
    search.value = this.filter;
    search.style.flex = "1";
    search.oninput = () => { this.filter = search.value.toLowerCase(); this.renderZonesOnly(); };

    const only = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.onlyChanged;
    cb.onchange = () => { this.onlyChanged = cb.checked; this.renderZonesOnly(); };
    only.append(cb, document.createTextNode("只看已调整"));

    row2.append(search, only);
    box.appendChild(row2);
    return box;
  }

  // 只重画区域列表，避免搜索时输入框失焦。
  // 全局/插件热载/自定义区域这些管理块带 data-nm-keep，搜索时不被清掉。
  renderZonesOnly() {
    for (const b of this.root.querySelectorAll(".nm-zone:not([data-nm-keep])")) b.remove();
    const tip = this.root.querySelector(".nm-tip");
    for (const zone of this.scan?.zones || []) {
      this.root.insertBefore(this.zoneBox(zone), tip);
    }
  }

  // ---------- 插件热载 ----------

  pluginBadges(rec) {
    const h = this.hot[rec.name] || {};
    const out = [];
    if (rec.disabled) out.push(this.warnBadge("已停用"));
    else if (!h.loaded) out.push(this.warnBadge("未载入"));
    if (h.stripped) out.push(this.warnBadge("热停用中"));
    if (rec.web) out.push(badge("JS"));
    return out;
  }

  warnBadge(text) {
    const b = badge(text);
    b.classList.add("nm-warn");
    return b;
  }

  async togglePlugin(name, enable) {
    if (!enable && !confirm(
      `停用 ${name}：它的节点类会立即从节点菜单移除，目录改名 .disabled（重启后保持停用）；` +
      `前端脚本与 HTTP 接口本次会话仍保留。继续？`)) return;
    try {
      const state = await this.fetchJSON(API.pluginToggle, { name, enable });
      if (state.result && !state.result.ok) {
        alert(`操作失败：${state.result.msg}`);
      } else if (state.result?.msg) {
        console.log("[nodes-Manager]", state.result.msg);
      }
      // 局部刷新：插件清单 / 热载状态 / 新配置条目并入，不动未保存的调整
      this.plugins = state.plugins || [];
      this.hot = state.hot || {};
      this.newPlugins = state.newPlugins || [];
      for (const [k, v] of Object.entries(state.config.items || {})) {
        if (!this.cfg.items[k]) this.cfg.items[k] = v;
      }
      this.render();
    } catch (err) {
      alert(`请求失败：${err.message}`);
    }
  }

  pluginsBox() {
    const box = el("details", "nm-zone");
    box.setAttribute("data-nm-keep", "1");
    const list = this.plugins || [];
    const f = (this.pluginFilter || "").toLowerCase();
    const filtered = f ? list.filter((p) => p.name.toLowerCase().includes(f)) : list;
    const disabledCount = list.filter((p) => p.disabled).length;

    const sum = el("summary");
    sum.append(document.createTextNode(`插件热载 `), badge(String(list.length)));
    if (disabledCount) sum.append(document.createTextNode(" "), this.warnBadge(`停用 ${disabledCount}`));
    box.appendChild(sum);

    box.appendChild(el("div", "nm-item nm-tip",
      "停用：立即移除它的节点类并把目录改名 .disabled（重启后保持停用）；前端脚本与 HTTP 接口本次会话仍保留，之后提交用到其节点的工作流会报错。\n" +
      "启用：目录改回原名并立即导入注册；前端 JS 要刷新页面才会加载。"));

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "按插件名过滤（共 " + list.length + " 个）";
    search.value = this.pluginFilter;
    search.style.flex = "1";
    search.oninput = () => { this.pluginFilter = search.value; this.renderPluginsList(); };
    box.appendChild(el("div", "nm-item", search));

    const listHost = el("div", "nm-plug-list");
    box.appendChild(listHost);
    this._pluginListHost = listHost;
    this.renderPluginsList();
    return box;
  }

  renderPluginsList() {
    const host = this._pluginListHost;
    if (!host) return;
    host.textContent = "";
    const f = (this.pluginFilter || "").toLowerCase();
    const filtered = (this.plugins || []).filter((p) => !f || p.name.toLowerCase().includes(f));
    const MAX = 150;
    for (const rec of filtered.slice(0, MAX)) {
      const row = el("div", "nm-plug-row");
      const name = el("span", "nm-plug-name", rec.name);
      name.title = rec.path;
      row.appendChild(name);
      for (const b of this.pluginBadges(rec)) row.appendChild(b);
      // 局部变量不能叫 btn —— 会遮蔽模块级的 btn()，const 提升后引用先于初始化
      // （TDZ），整个面板直接「加载失败」（实测）。
      const enable = rec.disabled || !(this.hot[rec.name] || {}).loaded;
      const act = btn(enable ? "启用" : "停用", () => this.togglePlugin(rec.name, enable));
      act.classList.add(enable ? "nm-primary" : "nm-danger");
      row.appendChild(act);
      host.appendChild(row);
    }
    if (filtered.length > MAX) {
      host.appendChild(el("div", "nm-item nm-tip", `还有 ${filtered.length - MAX} 个未显示，输入过滤缩小范围。`));
    }
    if (!filtered.length) {
      host.appendChild(el("div", "nm-item nm-tip", "没有匹配的插件"));
    }
  }

  newPluginsBox() {
    const box = el("details", "nm-zone");
    box.setAttribute("data-nm-keep", "1");
    box.open = true;
    const sum = el("summary");
    sum.append(document.createTextNode("新装的插件 "), badge(String(this.newPlugins.length)));
    box.appendChild(sum);
    box.appendChild(el("div", "nm-item nm-tip",
      this.newPlugins.join("、") + "\n（这些是相对上次启动新出现的插件目录；它们往界面里加的按钮会出现在下面对应区域里。）"));
    return box;
  }

  globalBox() {
    const g = this.cfg.global;
    const box = el("details", "nm-zone");
    box.setAttribute("data-nm-keep", "1");
    box.open = true;
    box.appendChild(el("summary", null, "全局"));

    const body = el("div", "nm-item");

    const mk = (labelText, node) => {
      const l = document.createElement("label");
      l.append(node, document.createTextNode(labelText));
      return l;
    };

    const r1 = el("div", "nm-ctl");
    r1.append(
      mk("总开关", checkbox(g.enabled !== false, (v) => { g.enabled = v; this.touch(); })),
      mk("允许折行", checkbox(!!g.wrap, (v) => { g.wrap = v; this.touch(); })),
      mk("新按钮默认显示", checkbox(g.autoReveal !== false, (v) => { g.autoReveal = v; this.touch(); })),
    );

    const r2 = el("div", "nm-ctl");
    r2.append(
      labeled("整条缩放", number(g.scale, 0.3, 3, 0.05, (v) => { g.scale = v; this.touch(); })),
      labeled("间距", number(g.gap, 0, 64, 1, (v) => { g.gap = v; this.touch(); })),
      labeled("字号", number(g.fontSize, 4, 64, 1, (v) => { g.fontSize = v; this.touch(); })),
      labeled("图标", number(g.iconSize, 4, 64, 1, (v) => { g.iconSize = v; this.touch(); })),
    );

    body.append(r1, r2, el("div", "nm-tip",
      "数值留空 = 不干预。字号设在按钮条上靠继承生效，插件自己写死字号的按钮改「图标」那一栏，或到下面单条调整。"));
    box.appendChild(body);
    return box;
  }

  // ---------- 自定义区域（悬浮卡片拾取） ----------

  zonesBox() {
    const box = el("details", "nm-zone");
    box.setAttribute("data-nm-keep", "1");
    const zones = this.cfg.zones || [];
    const sum = el("summary");
    sum.append(document.createTextNode("自定义区域 "), badge(String(zones.length)));
    box.appendChild(sum);

    box.appendChild(el("div", "nm-item nm-tip",
      "内置 9 个区域管不到的悬浮卡片（监控挂件、资源球等）从这里加：点「拾取悬浮卡片」，\n" +
      "再去页面上点一下那张卡片即可——卡片里的按钮/文字会出现在下面的区域列表里，照常调整。\n" +
      "拾取会立即保存。删除区域会连同它的条目配置一起清掉。"));

    const row = el("div", "nm-ctl");
    const pick = btn(this._picking ? "拾取中…（Esc 取消）" : "拾取悬浮卡片", () => this.startPick());
    pick.classList.add("nm-primary");
    row.appendChild(pick);
    box.appendChild(row);

    for (const z of zones) {
      const zrow = el("div", "nm-plug-row");
      const name = el("span", "nm-plug-name", z.label);
      const cnt = this.scan?.zones?.find((s) => s.id === "u:" + z.id);
      name.title = z.root + (cnt ? `\n条目 ${cnt.count} 个` : "\n（当前页面上没扫到，选择器可能失效）");
      zrow.appendChild(name);
      if (cnt && !cnt.present) zrow.appendChild(this.warnBadge("失效"));
      const del = btn("删除", () => this.removeZone(z.id));
      del.classList.add("nm-danger");
      zrow.appendChild(del);
      box.appendChild(zrow);
    }
    return box;
  }

  async removeZone(id) {
    this.cfg.zones = (this.cfg.zones || []).filter((z) => z.id !== id);
    // 区域删了，它名下的条目配置与探测记录一并清掉，不留孤儿
    const keys = Object.keys(this.cfg.items).filter((k) => k.startsWith("u:" + id + "|"));
    for (const k of keys) delete this.cfg.items[k];
    try {
      await this.fetchJSON(API.forget, { ids: keys });
    } catch { /* 记录清不掉不影响 */ }
    await this.save();
  }

  startPick() {
    if (this._picking) return;
    this._picking = true;
    this.render();

    const tip = el("div", null, "在页面上点击要管理的悬浮卡片（Esc 取消）");
    tip.setAttribute("data-nm-self", "1");
    Object.assign(tip.style, {
      position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", background: "#2563eb", color: "#fff",
      padding: "6px 14px", borderRadius: "8px", fontSize: "12px", pointerEvents: "none",
    });
    const hl = document.createElement("div");
    hl.setAttribute("data-nm-self", "1");
    Object.assign(hl.style, {
      position: "fixed", zIndex: "2147483646", display: "none",
      border: "2px solid #f59e0b", borderRadius: "4px", pointerEvents: "none",
      background: "rgba(245,158,11,.08)",
    });
    document.body.append(tip, hl);

    const move = (e) => {
      const t = e.target;
      if (!t || t.closest?.("[data-nm-self]")) { hl.style.display = "none"; this._pickTarget = null; return; }
      const root = pickWidgetRoot(t);
      this._pickTarget = root;
      const r = root.getBoundingClientRect();
      Object.assign(hl.style, {
        display: "block",
        left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px",
      });
    };
    const finish = (commit) => {
      removeEventListener("mouseover", move, true);
      removeEventListener("click", onClick, true);
      removeEventListener("keydown", onKey, true);
      tip.remove(); hl.remove();
      this._picking = false;
      const target = this._pickTarget;
      this._pickTarget = null;
      if (commit && target) this.addZoneFromPick(target);
      else this.render();
    };
    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.target?.closest?.("[data-nm-self]")) { finish(false); return; }
      finish(true);
    };
    const onKey = (e) => { if (e.key === "Escape") finish(false); };
    addEventListener("mouseover", move, true);
    addEventListener("click", onClick, true);
    addEventListener("keydown", onKey, true);
  }

  async addZoneFromPick(rootEl) {
    const rootSel = buildSelector(rootEl);
    if (!rootSel) {
      alert("这个元素找不到唯一的定位方式（没有专属 id/class，结构也会漂），\n试着点卡片里带边框的内容部分。");
      this.render();
      return;
    }
    const head = (rootEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 12);
    const label = (prompt("区域名称（显示在面板里）", head || "悬浮卡片") || "").trim() || "悬浮卡片";
    this.cfg.zones = this.cfg.zones || [];
    this.cfg.zones.push({ id: "z" + Date.now().toString(36), label, root: rootSel });
    try {
      await this.save();
      // 旧版后端会丢弃 zones 字段——保存后没存住就明说，别让用户以为拾取坏了
      if (!(this.cfg.zones || []).some((z) => z.root === rootSel)) {
        alert("自定义区域没能保存：运行中的 ComfyUI 后端是旧版，\n重启 ComfyUI 后再试一次。");
      }
    } catch (err) {
      alert(`保存失败：${err.message}`);
      this.render();
    }
  }

  zoneBox(zone) {
    const box = el("details", "nm-zone");
    if (!zone.present) box.setAttribute("data-absent", "1");

    const items = (this.scan?.items || []).filter((it) => it.zone === zone.id).filter((it) => {
      if (this.onlyChanged && !this.isChanged(it.key)) return false;
      if (!this.filter) return true;
      return (it.label + " " + it.cls.join(" ") + " " + it.key).toLowerCase().includes(this.filter);
    });

    const sum = el("summary");
    sum.append(document.createTextNode(`${zone.label} `), badge(String(items.length)));
    if (!zone.present) sum.append(document.createTextNode(" 未出现在页面上"));
    box.appendChild(sum);
    box.open = items.length > 0 && items.length <= 30 && !!this.filter;

    if (zone.hint) box.appendChild(el("div", "nm-item nm-tip", `${zone.root} — ${zone.hint}`));
    for (const it of items) box.appendChild(this.itemBox(it));
    if (!items.length) box.appendChild(el("div", "nm-item nm-tip", "这个区域没扫到可调条目"));
    return box;
  }

  itemBox(it) {
    const conf = this.itemConf(it.key);
    const box = el("div", "nm-item");
    if (this.isChanged(it.key)) box.classList.add("nm-on");

    box.onmouseenter = () => highlight(it.key);
    box.onmouseleave = () => highlight(null);

    const name = el("div", "nm-name", it.label);
    if (this.freshItems?.includes(it.key)) name.append(document.createTextNode(" "), badge("新"));
    if (!it.stable) {
      const b = badge("id 不稳定");
      b.classList.add("nm-warn");
      b.title = "这个元素没有可辨识特征，刷新后可能对不上，调整会失效";
      name.append(document.createTextNode(" "), b);
    }
    box.appendChild(name);

    const meta = [it.tag];
    if (it.cls.length) meta.push("." + it.cls.join("."));
    meta.push(`${it.rect[2]}×${it.rect[3]}`);
    if (!it.visible) meta.push("当前不可见");
    box.appendChild(el("div", "nm-meta", meta.join("  ")));

    const c1 = el("div", "nm-ctl");
    c1.append(
      wrapLabel("隐藏", checkbox(conf.hidden, (v) => { conf.hidden = v; this.touch(); box.classList.toggle("nm-on", this.isChanged(it.key)); })),
    );
    if (it.hasText && it.hasIcon) {
      c1.append(
        wrapLabel("只留图标", checkbox(conf.iconOnly, (v) => {
          conf.iconOnly = v; if (v) conf.labelOnly = false; this.touch(); this.render();
        })),
        wrapLabel("只留文字", checkbox(conf.labelOnly, (v) => {
          conf.labelOnly = v; if (v) conf.iconOnly = false; this.touch(); this.render();
        })),
      );
    }

    const c2 = el("div", "nm-ctl");
    c2.append(
      labeled("字号", number(conf.fontSize, 4, 64, 1, (v) => { conf.fontSize = v; this.touch(); })),
      labeled("图标", number(conf.iconSize, 4, 64, 1, (v) => { conf.iconSize = v; this.touch(); })),
      labeled("宽度", number(conf.width, 0, 4000, 5, (v) => { conf.width = v; this.touch(); })),
      labeled("排序", number(conf.order, -999, 999, 1, (v) => { conf.order = v; this.touch(); })),
    );

    const c3 = el("div", "nm-ctl");
    const reset = btn("复位", () => {
      Object.assign(conf, ITEM_DEFAULT);
      this.touch();
      this.render();
    });
    c3.append(reset);

    box.append(c1, c2, c3);
    return box;
  }
}

// ---------- 小工具 ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (text != null && /\n/.test(text)) e.style.whiteSpace = "pre-wrap";
  return e;
}

function btn(text, onclick) {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function badge(text) {
  const s = document.createElement("span");
  s.className = "nm-badge";
  s.textContent = text;
  return s;
}

function checkbox(checked, onchange) {
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = !!checked;
  c.onchange = () => onchange(c.checked);
  return c;
}

// 数值输入：空串 = null = 不干预
function number(value, min, max, step, onchange) {
  const n = document.createElement("input");
  n.type = "number";
  n.min = min; n.max = max; n.step = step;
  n.value = value == null ? "" : value;
  n.placeholder = "—";
  n.oninput = () => {
    const raw = n.value.trim();
    onchange(raw === "" ? null : Number(raw));
  };
  return n;
}

function labeled(text, node) {
  const l = document.createElement("label");
  l.append(document.createTextNode(text), node);
  return l;
}

function wrapLabel(text, node) {
  const l = document.createElement("label");
  l.append(node, document.createTextNode(text));
  return l;
}
