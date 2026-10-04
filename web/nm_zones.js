// 界面区域定义 + 运行时 DOM 扫描。
//
// 这里是全插件唯一「写死选择器」的地方。ComfyUI 前端版本一变、别的插件一更新，
// 选择器就可能失效 —— 所以集中在一处，改起来只用动这个文件。
//
// 已实测环境：comfyui-frontend-package 1.49.6 / ComfyUI 0.33.0，1920 视口。
// 该版本的重要事实（源码推断过一次全部落空，这些都是运行时实测的）：
//   * #comfyui-body-top 里**没有**顶栏，实测高仅 10px，只是旧版扩展挂载点
//   * 真正的顶部 UI 在 #graph-canvas-container 内一层 absolute overlay 里
//   * 主菜单 / logo 不在顶栏，在左侧竖栏顶部 .comfy-menu-button-wrapper
//   * 没有 File/Edit/Help 横向菜单栏，.p-menubar / .comfyui-menu 命中数为 0
//   * 其余是 Tailwind 原子类 + Vue scoped 属性选择器，覆盖时要 !important
//
// **不要用 :nth-child(n) 按序号选按钮** —— 实测两次加载之间插件的先后顺序会变。

export const ZONES = [
  {
    id: "actionbar",
    label: "顶部按钮条",
    root: ".actionbar-container",
    // 直接子元素就是一个个按钮/按钮组；有的插件多包了两层
    hint: "插件按钮最常落脚的地方",
  },
  {
    id: "tabs",
    label: "工作流标签行",
    root: ".workflow-tabs-container",
    hint: "标签页那一行，高度由 --workflow-tabs-height 控制",
  },
  {
    id: "rail",
    label: "左侧竖栏",
    root: ".side-tool-bar-container",
    hint: "侧栏图标按钮，logo / 主菜单也在这一栏顶部",
  },
  {
    id: "railEnd",
    label: "左侧竖栏底部",
    root: ".side-tool-bar-end",
    hint: "竖栏下半段（设置、主题等）",
  },
  {
    id: "bodyTop",
    label: "旧版顶部挂载点",
    root: "#comfyui-body-top",
    hint: "1.49.6 里只有旧版扩展会挂到这儿（如 rgthree 进度条）",
  },
  {
    id: "bodyBottom",
    label: "旧版底部挂载点",
    root: "#comfyui-body-bottom",
    hint: "",
  },
  {
    id: "bodyLeft",
    label: "旧版左侧挂载点",
    root: "#comfyui-body-left",
    hint: "",
  },
  {
    id: "bodyRight",
    label: "旧版右侧挂载点",
    root: "#comfyui-body-right",
    hint: "",
  },
  {
    id: "canvasMenu",
    label: "画布浮动菜单",
    root: ".graph-canvas-menu",
    hint: "画布左下角那排缩放/适配按钮",
  },
];

export const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));

// 图标字体的类名前缀，用来在按钮里认出「哪个子元素是图标」。
// mdi = Material Design Icons（第三方插件最常用），pi = PrimeIcons（ComfyUI 原生），
// fa = Font Awesome。这几套都是字体图标，字号一改就跟着缩放。
const ICON_CLASS = /(^|\s)(mdi|mdi-|pi|pi-|fa|fas|far|fab|fa-|material-icons|comfy-icon)/;

function isIconEl(el) {
  if (!el || !el.classList) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "svg" || tag === "img") return true;
  return ICON_CLASS.test(" " + Array.from(el.classList).join(" "));
}

// 一个元素里有没有图标 / 文字，决定面板上「只留图标」「只留文字」要不要给。
function probeParts(el) {
  let icon = false;
  let text = false;
  const walk = (node, depth) => {
    for (const kid of node.children || []) {
      if (isIconEl(kid)) icon = true;
      else if (depth > 0) walk(kid, depth - 1);
    }
    // 元素自己的直接文字节点
    for (const n of node.childNodes || []) {
      if (n.nodeType === 3 && n.textContent.trim()) text = true;
    }
  };
  walk(el, 3);
  if (!text && (el.textContent || "").trim()) text = true;
  return { icon, text };
}

function cleanText(el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

// key 的「基底」：把会漂的成分（文字内容、撞签名序号）归一成通配。
// 监控条那类元素文字每秒都在变，若照原样进 key，隐藏规则永远追不上 ——
// 实测同一元素会滚出 2-3 个变体 key，每个都露出过（这就是「页面一直闪」的主因之一）。
function keyBase(key) {
  return key.split("|").map((p) => (p.startsWith("t:") || p.startsWith("#")) ? p.slice(0, 2) + "*" : p).join("|");
}

// 给一个元素编一个**跨刷新稳定**的 id。
//
// 序号不稳定（实测插件加载顺序会变），所以优先用元素自带的稳定特征：
// 专属 class > id > aria-label/title > 内部图标类名 > 文字内容。
// 全都没有时才退回结构路径，并在面板上标出来「这条 id 不稳定」。
function stableKey(el, zoneId, depth) {
  // 标签名 + 相对区域根的深度先入 key。
  // 不加这两样会撞签名：`.actionbar-container > div.shrink-0` 里只有一个按钮时，
  // 外层 div 和里面的 button 文字、图标全都一样（实测「Compact IDs」就是这样），
  // 算出来的 key 一模一样，打标时两个元素拿到同一个 data-nm-id，
  // 结果隐藏一个会把外层一起藏掉。深度还顺带让兜底选择器能锚对层级。
  const parts = ["g:" + el.tagName.toLowerCase(), "d:" + depth];
  // 1. 专属 class：排掉 Tailwind 原子类和框架通用类
  const own = Array.from(el.classList || []).filter((c) => {
    if (c.length < 4) return false;
    if (/^(p-|flex|grid|items-|justify-|gap-|mx-|my-|px-|py-|pt-|pb-|pl-|pr-|ml-|mr-|mt-|mb-|w-|h-|text-|bg-|border|rounded|shrink|grow|absolute|relative|hidden|block|inline)/.test(c)) return false;
    if (/^(comfyui-button|comfy-button|comfyui-menu-mobile-collapse)$/.test(c)) return false;
    return true;
  });
  if (own.length) parts.push("c:" + own.sort().join(".").slice(0, 80));

  if (el.id) parts.push("i:" + el.id.slice(0, 60));

  const aria = el.getAttribute("aria-label") || el.getAttribute("title");
  if (aria) parts.push("a:" + aria.trim().slice(0, 40));

  // 2. 内部图标类名 —— 图标类名（如 pi-sort-numeric-down）通常比文字稳定，
  // 而且它能写成 CSS 选择器（:has()），文字不能，所以给兜底规则留了条路
  const icon = el.querySelector("[class*='mdi-'],[class*='pi-'],[class*='fa-']");
  if (icon) {
    const ic = Array.from(icon.classList).filter((c) => /-/.test(c)).sort().join(".");
    if (ic) parts.push("k:" + ic.slice(0, 60));
  }

  // 3. 文字内容。**数字必须归一化** —— 监控条那类文字每秒都在变
  // （CPU 45% → CPU 93%），照原样进签名的话 id 一直漂移，配置隔一秒就对不上。
  const txt = cleanText(el).replace(/\d+(?:[.,]\d+)?/g, "#");
  if (txt) parts.push("t:" + txt.slice(0, 30));

  // 除了 g:/d: 之外一个特征都没有 → 只能靠标签和层级认，标记为不稳定
  const stable = parts.length > 2;
  return { key: zoneId + "|" + parts.join("|"), stable };
}

// 扫一个区域，返回它下面的可调条目。
//
// 只取「看起来是一个按钮/控件」的元素，而不是每个 div 都列 —— 否则 500 个插件
// 会扫出几千条。判据：是 button / 有 role=button / 是按钮组，
// 或者是区域根的直接子元素（有些插件塞的是纯 div 容器）。
// light = 后台补扫用的轻量模式：只算 key 打标，不测量不探测。
// getBoundingClientRect 是扫描里唯一强制同步布局的动作，DOM 一变就来一遍的话
// 整页都在抖；rect / hasIcon / hasText 只有面板展示用得到，补扫用不上。
function collect(zone, light, knownKeys) {
  const root = document.querySelector(zone.root);
  if (!root) return { present: false, items: [] };

  const seen = new Set();
  const out = [];
  const push = (el, depth) => {
    if (!el || seen.has(el)) return;
    // 跳过我们自己注入的东西
    if (el.closest?.("[data-nm-self]")) return;
    // 自己的侧栏页签按钮不扫：它被吞掉面板就没有入口了（autoReveal=false
    // 会把新条目预置隐藏，我们的页签按钮也吃这套，实测被藏过）
    const own = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "";
    if (typeof own === "string" && own.startsWith("ComfyUI-nodes-Manager")) return;
    seen.add(el);
    const r = light ? null : el.getBoundingClientRect();
    const { key, stable } = stableKey(el, zone.id, depth);
    // **key 粘滞**：文字漂移不该换身份。
    //   a) 元素已经打过标、且新旧 key 只差文字/序号 → 沿用旧 key；
    //   b) 新元素、但配置里已有同基底 key（只差文字）→ 沿用配置那份
    //      （用户已经调过的条目不因文字一变就「变新」）。
    // 都不满足才用刚算出来的 —— 元素真的换了内容才换身份。
    let finalKey = key;
    const prev = el.getAttribute("data-nm-id");
    if (prev && prev !== key && keyBase(prev) === keyBase(key)) {
      finalKey = prev;
    } else if (!prev && knownKeys) {
      const base = keyBase(key);
      for (const kk of knownKeys) {
        if (keyBase(kk) === base) { finalKey = kk; break; }
      }
    }
    const parts = light ? { icon: false, text: false } : probeParts(el);
    out.push({
      key: finalKey,
      stable,
      zone: zone.id,
      depth,
      label: cleanText(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "(无文字)",
      tag: el.tagName.toLowerCase(),
      cls: Array.from(el.classList || []).slice(0, 6),
      hasIcon: parts.icon,
      hasText: parts.text,
      rect: light ? [0, 0, 0, 0] : [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      visible: light ? true : r.width > 0 && r.height > 0,
      el,
    });
  };

  // 相对区域根的深度：直接子元素 = 1
  const depthOf = (el) => {
    let d = 0;
    for (let p = el; p && p !== root; p = p.parentElement) d += 1;
    return d;
  };

  // 直接子元素：包括那些没有 class 的纯包装 div
  for (const kid of root.children) push(kid, 1);
  // 再往里挖按钮，覆盖「包装 div 里装了一排按钮」的情形
  for (const btn of root.querySelectorAll("button,[role='button'],.comfyui-button,.comfy-button")) {
    if (btn.parentElement && btn.parentElement !== root) push(btn, depthOf(btn));
  }

  // 撞签名兜底：标签 + 深度 + 特征都一样的（比如同一排里两个长得一模一样的按钮），
  // 按文档顺序补个序号。序号会随插件加载顺序漂，所以这些条目一并标成不稳定，
  // 面板上会提示「刷新后可能对不上」。
  const bucket = new Map();
  for (const it of out) bucket.set(it.key, (bucket.get(it.key) || 0) + 1);
  const used = new Map();
  for (const it of out) {
    if (bucket.get(it.key) < 2) continue;
    const n = used.get(it.key) || 0;
    used.set(it.key, n + 1);
    it.key = `${it.key}|#${n}`;
    it.stable = false;
  }

  return { present: true, items: out };
}

// 扫全部区域。返回 {zones: [...], items: [...]}；items 里带 el 引用，
// 面板用它做「鼠标悬停高亮」，提交给后端前要剥掉。
// opts.light —— 后台补扫用，不测量不探测；
// opts.knownKeys —— 配置里已有的 key 集合，新元素同基底时直接沿用（key 粘滞）。
export function scanUI(opts) {
  const light = !!opts?.light;
  const knownKeys = opts?.knownKeys || null;
  const zones = [];
  const items = [];
  for (const zone of ZONES) {
    const res = collect(zone, light, knownKeys);
    zones.push({
      id: zone.id,
      label: zone.label,
      root: zone.root,
      hint: zone.hint,
      present: res.present,
      count: res.items.length,
    });
    items.push(...res.items);
  }
  return { zones, items };
}

// 提交给后端的精简形态（去掉 DOM 引用）。
export function toPayload(items) {
  return items.map((it) => ({ id: it.key, label: it.label, zone: it.zone }));
}
