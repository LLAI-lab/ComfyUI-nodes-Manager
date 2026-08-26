// 把配置渲染成 CSS，并注入到页面。
//
// 关键设计：**不靠猜选择器，靠运行时打标**。
//
// 早先的做法是从元素特征反推 CSS 选择器（.actionbar-container button:has(i.pi-xxx)
// 这种），问题是相当一部分插件按钮没有专属 class，只能靠文字内容区分，而文字
// 没法写进选择器；写死结构路径又会被插件加载顺序的变化打乱。
//
// 所以改成：扫描时给每个条目的元素打上 `data-nm-id="<key>"`，
// CSS 一律写成 `[data-nm-id="<key>"] { ... }`。属性值来自我们自己，
// 不受前端版本和别的插件影响，精确命中且不会串。
//
// 代价：CSS 只有在 JS 打标之后才生效（首屏会闪一下原始布局）。为压掉这个闪动，
// 「隐藏」这一类还额外走一条 :has() 兜底规则（见 hideFallback）。

const STYLE_ID = "nm-injected-style";
const MARK_ATTR = "data-nm-id";

// 图标子元素的选择器：这几套字体图标覆盖了绝大多数插件
const ICON_SEL = "i,svg,img,[class*='mdi-'],[class*='pi-'],[class*='fa-'],.material-icons";
// 文字子元素：按钮里通常把文字包在 span 里
const TEXT_SEL = "span,label,b,strong";

function esc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

function sel(key) {
  return `[${MARK_ATTR}="${esc(key)}"]`;
}

// 给扫描到的元素打标。返回实际打上的条数。
export function markAll(items) {
  let n = 0;
  for (const it of items || []) {
    if (!it.el || !it.el.setAttribute) continue;
    if (it.el.getAttribute(MARK_ATTR) !== it.key) it.el.setAttribute(MARK_ATTR, it.key);
    n += 1;
  }
  return n;
}

export function unmarkAll() {
  for (const el of document.querySelectorAll(`[${MARK_ATTR}]`)) el.removeAttribute(MARK_ATTR);
}

// 一个条目的规则。
//
// 宽度那几条必须配 min-width:0 + overflow:hidden —— 这些按钮的宽度是内容
// （图标 + 文字）撑出来的，光写 width 会被内容顶回去，实测无效。
function itemRules(key, conf) {
  const s = sel(key);
  const out = [];

  if (conf.hidden) {
    out.push(`${s}{display:none!important}`);
    return out;                       // 已经藏了，其余的不用写
  }

  // 字号。设在条目上靠继承生效，所以插件自己写死字号的子元素管不到，
  // 那种情况用下面的 iconSize 单独压图标。
  if (conf.fontSize != null) out.push(`${s}{font-size:${conf.fontSize}px!important}`);

  // 图标大小。字体图标认 font-size，svg/img 认 width/height，两条都写。
  if (conf.iconSize != null) {
    const n = conf.iconSize;
    out.push(`${s} ${ICON_SEL.split(",").map((x) => x.trim()).join(`,${s} `)}{font-size:${n}px!important;line-height:1!important}`);
    out.push(`${s} svg,${s} img{width:${n}px!important;height:${n}px!important}`);
  }

  if (conf.iconOnly) {
    // 藏文字：只藏「纯文字」的子元素，别把图标包装一起藏了
    out.push(`${s} ${TEXT_SEL.split(",").map((x) => x.trim()).join(`,${s} `)}{display:none!important}`);
  }
  if (conf.labelOnly) {
    out.push(`${s} ${ICON_SEL.split(",").map((x) => x.trim()).join(`,${s} `)}{display:none!important}`);
  }

  if (conf.width != null) {
    out.push(`${s}{width:${conf.width}px!important;min-width:0!important;overflow:hidden!important;flex:0 0 auto!important}`);
  }

  // 位置。order 只在父容器是 flex 时有效（顶部按钮条是），负数排到前面。
  // 注意 order 会把它钉到**行首**，而不是原来的相对位置。
  if (conf.order != null) out.push(`${s}{order:${conf.order}!important}`);

  return out;
}

// 全局规则。
function globalRules(g) {
  const out = [];
  const bar = ".actionbar-container";

  // 整条等比缩放。用 zoom 而不是 transform:scale() —— zoom 会真实压缩占位宽度，
  // scale 不会（视觉缩小但照样占原来那么宽）。
  if (g.scale != null) out.push(`${bar}{zoom:${g.scale}!important}`);
  if (g.gap != null) out.push(`${bar}{gap:${g.gap}px!important;column-gap:${g.gap}px!important}`);
  if (g.fontSize != null) out.push(`${bar}{font-size:${g.fontSize}px!important}`);
  if (g.iconSize != null) {
    const n = g.iconSize;
    out.push(`${bar} i,${bar} [class*='mdi-'],${bar} [class*='pi-'],${bar} [class*='fa-']{font-size:${n}px!important;line-height:1!important}`);
    out.push(`${bar} svg,${bar} img{width:${n}px!important;height:${n}px!important}`);
  }

  // 折行。光加 flex-wrap 无效 —— 按钮条宽度是 shrink-to-fit，可用宽度永远
  // 等于内容宽度，wrap 永不触发。必须先给它确定宽度。
  //
  // 另外插件按钮多埋在两层包装里（.actionbar-container > div[...] > div.flex...），
  // 只给外层加 wrap 没用（它只有一个子元素）。用 display:contents 把两层包装
  // 打平，让按钮成为按钮条的直接 flex 项，统一参与 wrap，装箱最省。
  // 代价：包装层的 gap-2 / mx-2 会随之失效，所以上面 gap 要自己补。
  if (g.wrap) {
    out.push(`${bar}{flex-wrap:wrap!important;width:100%!important;justify-content:flex-start!important}`);
    out.push(`${bar} > div[class*="]:hidden"],${bar} > div > div.flex.gap-2{display:contents!important}`);
    // 打平后按钮要防挤压，否则内部会被压到最窄、文字换行，整条反而更高
    out.push(`${bar} > .comfyui-button-group,${bar} > button{flex:0 0 auto!important}`);
  }

  return out;
}

// 隐藏项的首屏兜底：在 JS 打标之前，用 :has() 按特征命中，压掉闪动。
//
// 只对「隐藏」做，因为闪一下再消失最显眼。用得上的特征只有 aria-label / title /
// 专属 class / 图标类名 —— 文字内容 CSS 选不了，那种就只能等打标。
// :has() 在 Chrome 105+ 支持，ComfyUI 的目标浏览器都有。
function hideFallback(key, zoneRoot) {
  const bits = key.split("|").slice(1);
  // key 里的 g: 段是元素自己的标签名。图标特征那条必须锚在它上面 ——
  // 图标类名长在子元素上，用 :has() 回选时若一律写 button，就会选到
  // 「包着这个按钮的 div」以外的东西，或者反过来选不中 div 本体（实测
  // .actionbar-container > div.shrink-0 里只有一个按钮时就是这种情况）。
  const tag = (bits.find((b) => b.startsWith("g:")) || "g:*").slice(2) || "*";
  // 撞签名补的 |#n 序号没法写进选择器，这类条目不做兜底，等打标
  if (bits.some((b) => b.startsWith("#"))) return null;
  for (const p of bits) {
    const val = p.slice(2);
    if (!val) continue;
    if (p.startsWith("i:")) return `${zoneRoot} #${cssIdent(val)}`;
    if (p.startsWith("a:")) return `${zoneRoot} [aria-label="${esc(val)}"],${zoneRoot} [title="${esc(val)}"]`;
    if (p.startsWith("c:")) {
      const cls = val.split(".").filter(Boolean).map(cssIdent).map((c) => "." + c).join("");
      if (cls) return `${zoneRoot} ${cls}`;
    }
    if (p.startsWith("k:")) {
      const cls = val.split(".").filter(Boolean).map(cssIdent).map((c) => "." + c).join("");
      if (cls) return `${zoneRoot} ${tag}:has(${cls})`;
    }
  }
  return null;
}

// class / id 里可能有 CSS 标识符非法字符，转义一下（CSS.escape 会把开头数字等处理掉）
function cssIdent(s) {
  try {
    return CSS.escape(s);
  } catch {
    return String(s).replace(/[^\w-]/g, "\\$&");
  }
}

// 渲染整份 CSS。zonesById 用来给兜底规则找区域根选择器。
export function renderCSS(cfg, zonesById) {
  const g = cfg?.global || {};
  if (g.enabled === false) return "/* nodes-Manager: 总开关已关闭 */";

  const lines = ["/* ComfyUI-nodes-Manager 自动生成，改这里没用，请在侧栏面板里调 */"];
  lines.push(...globalRules(g));

  const items = cfg?.items || {};
  const fallbacks = [];
  for (const key of Object.keys(items)) {
    const conf = items[key];
    if (!conf) continue;
    lines.push(...itemRules(key, conf));
    if (conf.hidden) {
      const zoneId = key.split("|")[0];
      const root = zonesById?.[zoneId]?.root;
      if (root) {
        const fb = hideFallback(key, root);
        if (fb) fallbacks.push(fb);
      }
    }
  }
  if (fallbacks.length) {
    lines.push("/* 首屏兜底：JS 打标之前先按特征藏掉，压掉闪动 */");
    lines.push(`${fallbacks.join(",")}{display:none!important}`);
  }

  return lines.join("\n");
}

// 注入 / 更新样式。复用同一个 id 固定的 <style>，改 textContent 立即重排，
// 不用重新导航页面（这台 ComfyUI 首屏要 100-185 秒，重载代价很高）。
export function applyCSS(css) {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    el.setAttribute("data-nm-self", "1");
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  return el;
}

// 面板上「鼠标悬停高亮」用的临时描边，走一条独立的 style 节点，不污染主样式。
const HL_ID = "nm-highlight-style";

export function highlight(key) {
  let el = document.getElementById(HL_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = HL_ID;
    el.setAttribute("data-nm-self", "1");
    document.head.appendChild(el);
  }
  el.textContent = key
    ? `${sel(key)}{outline:2px solid #f59e0b!important;outline-offset:1px!important}`
    : "";
}

export { MARK_ATTR, STYLE_ID };
