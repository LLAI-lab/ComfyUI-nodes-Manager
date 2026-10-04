// ComfyUI-nodes-Manager 前端入口。
//
// 做三件事：
//   1. 模块一加载就拉配置、把 CSS 注进页面 —— 不等 app 初始化完，赶在界面
//      画出来之前生效，压掉首屏闪动；
//   2. 注册侧栏面板；
//   3. 盯着 DOM 变化，在**绘制前**补打标记。
//
// 为什么补标必须抢在绘制前：nm_style.js 生成的 CSS 全部按 data-nm-id 属性选，
// 而这个属性是扫描时我们自己打上去的。不少插件会整块重建自己的按钮组
// （监控条每次刷新都是），元素一重建标记就丢了 —— 要是过几百毫秒才补上，
// 配置过的样式（尤其「隐藏」）会先恢复原样再被藏回去，页面就一直闪。
// MutationObserver 的回调是微任务，跑在浏览器画下一帧之前，在这里同步补标，
// 重建的元素来不及以原始样式露脸。真正费时的测量与上报才允许延后。
//
// 为什么补扫要持续：这台机器几百个插件，实测首屏要 100-185 秒才稳定，
// 启动时扫一次远远不够。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { Panel } from "./nm_panel.js";
import { scanUI, toPayload, ZONE_BY_ID } from "./nm_zones.js";
import { applyCSS, markAll, renderCSS } from "./nm_style.js";
import { installCanvasMenu, openPanel } from "./nm_entry.js";

const TAB_ID = "nodes-manager";

// 上报的节流间隔。必须节流不能去抖：进度条那类组件每秒变几十次，
// 去抖每次都被重置，永远凑不满安静窗口，上报会被饿死。
const REPORT_THROTTLE = 500;
// 启动后的补扫时刻（毫秒）。插件按钮陆续到位，多扫几次比定一个长延时靠谱。
const BOOT_SWEEPS = [800, 2000, 5000, 10000, 20000, 45000];

let cfg = null;          // 当前配置；面板改动后通过 onApply 换成面板那份
let observer = null;
let reported = new Set();
let reportTimer = null;

function zonesById() {
  const out = {};
  for (const [id, z] of Object.entries(ZONE_BY_ID)) out[id] = { root: z.root };
  return out;
}

// CSS 只随 cfg 重渲染。cfg 只在面板保存 / 撤销时整体换引用，比较引用即可，
// 不必每轮扫描都把几百条规则重新拼一遍字符串。
let cssForCfg = null;
let cssCache = "";
function cachedCSS() {
  if (cssForCfg !== cfg) {
    cssForCfg = cfg;
    cssCache = renderCSS(cfg, zonesById());
  }
  return cssCache;
}

// 轻扫：打标 + 必要时重注入 CSS。light 模式不测量（getBoundingClientRect
// 会强制同步布局，每次 DOM 变更都来一遍整页都在抖）、不探测图标文字细节。
// knownKeys 传配置里已有的 key：文字漂移的元素（监控条）按基底沿用旧身份，
// 隐藏规则才能一直命中 —— 实测不粘住的话隐藏项每秒都要「闪现」几次。
function quickPass() {
  if (!cfg) return null;
  const known = Object.keys(cfg.items || {});
  const { items } = scanUI({ light: true, knownKeys: known });
  markAll(items);
  applyCSS(cachedCSS());
  return items;
}

// 上报延后且节流；打标永远同步（见文件头）。
function scheduleReport() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => reportSeen(quickPass()), REPORT_THROTTLE);
}

// 上报本次扫到的条目，后端据此判断「哪些界面条目是新出现的」。
// 只报没报过的，省得 DOM 每动一下就发一次全量。失败不影响调整。
//
// 服务端的响应里带**权威配置**：autoReveal=false 时新条目会被预置为隐藏。
// 必须把它并回来重渲染，否则前端按启动时的旧配置打标，新隐藏项一直露着 ——
// 只并入当前没有的 key，不碰面板里未保存的改动。
async function reportSeen(items) {
  const fresh = (items || []).filter((it) => !reported.has(it.key));
  if (!fresh.length) return;
  for (const it of fresh) reported.add(it.key);
  try {
    const res = await api.fetchApi("/nodes_manager/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ found: toPayload(fresh) }),
    });
    if (res.ok) {
      const state = await res.json();
      let changed = false;
      for (const [k, v] of Object.entries(state.config?.items || {})) {
        if (!cfg.items[k]) { cfg.items[k] = v; changed = true; }
      }
      if (changed) { cssForCfg = null; applyCSS(cachedCSS()); }
    }
  } catch (err) {
    console.warn("[nodes-Manager] 条目上报失败（不影响界面调整）", err);
  }
}

async function loadConfig() {
  // no-store：浏览器可能把旧响应缓存到内存里，刷新后读到上一次的总开关
  // 状态（实测发生过：服务端已是 enabled=true，页面刷出来还是关闭）
  const res = await api.fetchApi("/nodes_manager/state", { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /nodes_manager/state → HTTP ${res.status}`);
  const state = await res.json();
  cfg = state.config;
  return state;
}

// 注册侧栏面板。放在最前面做，即使配置读取失败也能打开面板去排查。
function registerTab() {
  const em = app.extensionManager;
  if (!em?.registerSidebarTab) {
    console.warn("[nodes-Manager] 此前端版本没有 registerSidebarTab，面板不可用");
    return false;
  }
  em.registerSidebarTab({
    id: TAB_ID,
    icon: "pi pi-sliders-h",
    title: "界面管理",
    tooltip: "ComfyUI-nodes-Manager：调整插件按钮的字号 / 图标 / 显隐 / 位置",
    type: "custom",
    render: (el) => {
      const panel = new Panel(api);
      panel.onApply = (next) => { cfg = next; };
      panel.mount(el);
    },
  });
  return true;
}

// 配置拉取从模块加载就开始：setup() 要等 app 初始化完才跑，那时界面已经
// 画了一半；fetch 不依赖 DOM，能多早是多早。CSS 一到就注入，首屏不再露原样。
const cfgReady = loadConfig()
  .then(() => {
    applyCSS(cachedCSS());
    quickPass();
  })
  .catch((err) => {
    // 配置读不到就什么都不做 —— 宁可界面不调整，也不能把界面搞坏
    console.error("[nodes-Manager] 配置读取失败，界面调整未生效", err);
    return null;
  });

app.registerExtension({
  name: "Comfy.NodesManager",

  async setup() {
    registerTab();
    // 右键画布 → 「界面管理」：独立浮动窗口，侧栏页签被隐藏时也能打开面板
    installCanvasMenu(app, () => openPanel(api));

    await cfgReady;
    if (!cfg) return;                       // 配置读取失败，上面已经报过错

    const items = quickPass();
    reportSeen(items);
    for (const at of BOOT_SWEEPS) setTimeout(() => reportSeen(quickPass()), at);

    // 只盯子元素增减，不盯属性 —— 盯属性会被我们自己打 data-nm-id 触发，
    // 绕成死循环。回调里同步补标，元素被重建也来不及闪。
    observer = new MutationObserver(() => {
      quickPass();
      scheduleReport();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 视口一变折行结果就变，补一轮拿新尺寸（面板里显示的宽高会跟着更新）
    addEventListener("resize", () => { quickPass(); scheduleReport(); });

    console.log(`[nodes-Manager] 界面配置已注入，扫到 ${items.length} 个可调条目`);
  },
});
