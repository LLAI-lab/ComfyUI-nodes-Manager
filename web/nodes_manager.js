// ComfyUI-nodes-Manager 前端入口。
//
// 做三件事：
//   1. 启动就把保存好的配置注入页面 —— 不用打开面板，界面调整照样生效；
//   2. 注册侧栏面板；
//   3. 盯着 DOM 变化补打标记。
//
// 为什么要「补打标记」：nm_style.js 生成的 CSS 全部按 data-nm-id 属性选，
// 而这个属性是扫描时我们自己打上去的。第三方插件的按钮多是 setup() 之后
// 异步塞进来的（这台机器几百个插件，实测首屏要 100-185 秒才稳定），
// 启动时扫一次远远不够，必须持续补扫。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { Panel } from "./nm_panel.js";
import { scanUI, toPayload, ZONE_BY_ID } from "./nm_zones.js";
import { applyCSS, markAll, renderCSS } from "./nm_style.js";

const TAB_ID = "nodes-manager";

// DOM 一变就扫太费，攒一下再扫
const SWEEP_DEBOUNCE = 400;
// 启动后的补扫时刻（毫秒）。插件按钮陆续到位，多扫几次比定一个长延时靠谱。
const BOOT_SWEEPS = [800, 2000, 5000, 10000, 20000, 45000];

let cfg = null;          // 当前配置；面板改动后通过 onApply 换成面板那份
let timer = null;
let observer = null;
let reported = new Set();

function zonesById() {
  const out = {};
  for (const [id, z] of Object.entries(ZONE_BY_ID)) out[id] = { root: z.root };
  return out;
}

// 扫 DOM → 打标 → 重新注入 CSS。打标是幂等的（属性值一样就不写），
// 所以可以放心反复调。返回这次扫到的条目。
function sweep() {
  if (!cfg) return [];
  const { items } = scanUI();
  markAll(items);
  applyCSS(renderCSS(cfg, zonesById()));
  return items;
}

function scheduleSweep() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const items = sweep();
    reportSeen(items);
  }, SWEEP_DEBOUNCE);
}

// 上报本次扫到的条目，后端据此判断「哪些界面条目是新出现的」。
// 只报没报过的，省得 DOM 每动一下就发一次全量。失败不影响调整。
async function reportSeen(items) {
  const fresh = (items || []).filter((it) => !reported.has(it.key));
  if (!fresh.length) return;
  for (const it of fresh) reported.add(it.key);
  try {
    await api.fetchApi("/nodes_manager/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ found: toPayload(fresh) }),
    });
  } catch (err) {
    console.warn("[nodes-Manager] 条目上报失败（不影响界面调整）", err);
  }
}

async function loadConfig() {
  const res = await api.fetchApi("/nodes_manager/state");
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

app.registerExtension({
  name: "Comfy.NodesManager",

  async setup() {
    registerTab();

    try {
      await loadConfig();
    } catch (err) {
      // 配置读不到就什么都不做 —— 宁可界面不调整，也不能把界面搞坏
      console.error("[nodes-Manager] 配置读取失败，界面调整未生效", err);
      return;
    }

    const items = sweep();
    reportSeen(items);
    for (const at of BOOT_SWEEPS) setTimeout(() => reportSeen(sweep()), at);

    // 之后靠 DOM 变化驱动。**只盯子元素增减，不盯属性** ——
    // 盯属性会被我们自己打 data-nm-id 触发，绕成死循环。
    observer = new MutationObserver(scheduleSweep);
    observer.observe(document.body, { childList: true, subtree: true });

    // 视口一变折行结果就变，重扫一次拿新尺寸（面板里显示的宽高会跟着更新）
    addEventListener("resize", scheduleSweep);

    console.log(`[nodes-Manager] 界面配置已注入，扫到 ${items.length} 个可调条目`);
  },
});
