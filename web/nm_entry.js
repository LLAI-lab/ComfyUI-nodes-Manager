// 右键菜单入口 + 浮动面板窗口。
//
// 为什么不能只靠侧栏页签：页签按钮本身也在管理范围内，`新按钮默认显示`
// 关掉时新条目一律预置隐藏，我们自己的页签一旦被吞，面板就没有入口了 ——
// 死锁（实测发生过：用户配置里页签按钮 hidden=true，侧栏又整条藏了）。
// 所以在画布右键菜单里加一项「界面管理」，点开用**独立浮动窗口**承载面板，
// 不依赖侧栏是否可见。

import { Panel } from "./nm_panel.js";

const MENU_LABEL = "界面管理（nodes-Manager）";
let winEl = null;

// 浮动窗口：可拖动；再次调用时先关掉已开的（toggle）。
// 每次打开都新建 Panel 实例，读到的总是当前配置。
export function openPanel(api) {
  if (winEl) {
    winEl.remove();
    winEl = null;
    return;
  }

  const host = document.createElement("div");
  host.setAttribute("data-nm-self", "1");
  Object.assign(host.style, {
    position: "fixed", right: "28px", top: "72px",
    width: "380px", height: "min(72vh, 660px)",
    display: "flex", flexDirection: "column",
    background: "var(--comfy-menu-bg, #1e1e1e)",
    color: "var(--fg-color, #ddd)",
    border: "1px solid #555", borderRadius: "10px",
    boxShadow: "0 10px 34px rgba(0,0,0,.55)",
    zIndex: "99999", overflow: "hidden",
    font: "12px/1.5 sans-serif",
  });

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "6px 10px", cursor: "move", userSelect: "none",
    borderBottom: "1px solid #444", background: "rgba(255,255,255,.04)",
  });
  const title = document.createElement("span");
  title.textContent = MENU_LABEL;
  const close = document.createElement("button");
  close.textContent = "✕";
  Object.assign(close.style, { all: "unset", cursor: "pointer", padding: "0 4px" });
  close.onclick = () => { host.remove(); winEl = null; };
  bar.append(title, close);

  const body = document.createElement("div");
  Object.assign(body.style, { flex: "1", minHeight: "0" });

  host.append(bar, body);
  document.body.appendChild(host);
  winEl = host;

  // 按住标题栏拖动
  bar.addEventListener("pointerdown", (e) => {
    if (e.target === close) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      host.style.left = Math.max(0, ev.clientX - dx) + "px";
      host.style.top = Math.max(0, ev.clientY - dy) + "px";
      host.style.right = "auto";
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });

  new Panel(api).mount(body);
}

// 给画布右键菜单加一项。挂到 canvas 类的原型上（各家扩展通用的做法），
// app.canvas 就绪前先重试；重复调用安全。
export function installCanvasMenu(app, onOpen) {
  const tryPatch = () => {
    const proto = app.canvas && Object.getPrototypeOf(app.canvas);
    if (!proto || typeof proto.getCanvasMenuOptions !== "function") return false;
    if (!proto.__nmMenuPatched) {
      const orig = proto.getCanvasMenuOptions;
      proto.getCanvasMenuOptions = function () {
        const opts = orig.apply(this, arguments);
        if (Array.isArray(opts) && !opts.some((o) => o && o.content === MENU_LABEL)) {
          opts.push(null, { content: MENU_LABEL, callback: () => onOpen() });
        }
        return opts;
      };
      proto.__nmMenuPatched = true;
    }
    return true;
  };

  if (tryPatch()) return true;

  // app.canvas 可能比 setup 晚就绪。一直补不上就退而求其次：在画布元素上
  // 监听 contextmenu，弹一个只有一项的小菜单（不 preventDefault，
  // ComfyUI 自己的菜单照出，我们的浮在上面）。
  let n = 0;
  const t = setInterval(() => {
    if (tryPatch() || ++n > 40) {
      clearInterval(t);
      if (!tryPatch()) {
        console.warn("[nodes-Manager] 画布右键菜单挂不上（getCanvasMenuOptions 不存在），改用独立右键入口");
        const canvas = document.querySelector("#graph-canvas-container canvas")
          || document.querySelector("canvas");
        canvas?.addEventListener("contextmenu", (e) => {
          const menu = document.createElement("div");
          menu.setAttribute("data-nm-self", "1");
          Object.assign(menu.style, {
            position: "fixed", left: e.clientX + "px", top: e.clientY + "px",
            padding: "6px 14px", cursor: "pointer", zIndex: "99999",
            background: "var(--comfy-menu-bg, #1e1e1e)", color: "inherit",
            border: "1px solid #555", borderRadius: "6px",
            boxShadow: "0 6px 20px rgba(0,0,0,.5)", fontSize: "12px",
          });
          menu.textContent = MENU_LABEL;
          menu.onclick = () => { onOpen(); menu.remove(); };
          document.body.appendChild(menu);
          setTimeout(() => {
            addEventListener("pointerdown", () => menu.remove(), { once: true });
            setTimeout(() => menu.remove(), 4000);
          }, 0);
        });
      }
    }
  }, 500);
  return false;
}
