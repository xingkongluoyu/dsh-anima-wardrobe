// dsh_anima_bridge —— DSH 侧边栏「Anima 面板」的 ComfyUI 侧桥接。
//
// 1) 页面带 ?dshPanel=1 时，自动点开 AnimaWardrobe 的「⚙ 打开随机面板」
// 2) 每 2 秒把节点上的「场景搭配 / 定点锁定 / 勾选池」上报给父窗口（DSH 面板）
// 3) 左下角有一个绿色小角标，显示桥接自身状态（排查用，可安全忽略）
//
// 不改 AnimaWardrobe 任何文件；卸载只需删掉这个文件夹。
import { app } from "../../scripts/app.js";

const AUTO_FLAG = "dshPanel";
const SOURCE = "dsh-anima-bridge";
const PANEL_SELECTOR = ".av3-panel";

let badge = null;
let sent = 0;

function showBadge(text) {
  try {
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText =
        "position:fixed;left:8px;bottom:8px;z-index:2147483000;background:rgba(0,0,0,.78);" +
        "color:#4ade80;font:12px/1.4 monospace;padding:4px 8px;border-radius:4px;pointer-events:none;" +
        "white-space:pre;box-shadow:0 2px 8px rgba(0,0,0,.4)";
      document.body.appendChild(badge);
    }
    badge.textContent = text;
  } catch {
    /* document 还没 body 时忽略 */
  }
}

function post(payload) {
  sent += 1;
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: SOURCE, ...payload }, "*");
    }
  } catch {
    /* 跨源时静默失败 */
  }
}

function animaNodes() {
  const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
  return nodes.filter((node) => /AnimaV[3-6]RandomPrompt/i.test(String(node?.type ?? node?.comfyClass ?? "")));
}

function findButton(node) {
  const widgets = node?.widgets ?? [];
  return widgets.find((widget) => /打开随机面板/u.test(String(widget?.name ?? ""))) ?? null;
}

function panelShown() {
  return Boolean(document.querySelector(PANEL_SELECTOR));
}

function tryOpen() {
  if (panelShown()) {
    post({ type: "aw:opened", how: "already" });
    return true;
  }
  const node = animaNodes()[0];
  if (!node) return false;
  const button = findButton(node);
  if (!button) return false;
  try {
    if (typeof button.callback === "function") button.callback();
    else if (typeof button.options?.callback === "function") button.options.callback();
    else return false;
  } catch (error) {
    post({ type: "aw:error", detail: String((error && error.message) || error) });
    return false;
  }
  if (panelShown()) {
    post({ type: "aw:opened", how: "click" });
    return true;
  }
  return false;
}

function widgetValue(node, name) {
  const widget = (node?.widgets ?? []).find((item) => item?.name === name);
  return widget ? widget.value : undefined;
}

function collectState() {
  const node = animaNodes()[0];
  if (!node) return null;
  let forced = "";
  try {
    const raw = widgetValue(node, "weights_json");
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    forced = String(parsed?.forced?.n_canon ?? "");
  } catch {
    /* 旧格式没有 forced */
  }
  return {
    scenePick: widgetValue(node, "scene_pick") === true,
    pickPoolMode: String(widgetValue(node, "pick_pool_mode") ?? ""),
    pickPoolIds: String(widgetValue(node, "pick_pool_ids") ?? ""),
    forcedScene: forced,
    selectedRoles: String(widgetValue(node, "selected_roles") ?? ""),
    roleWorks: String(widgetValue(node, "role_works") ?? ""),
    nsfwLevel: String(widgetValue(node, "nsfw_level") ?? ""),
  };
}

// ---- 保存工作流（父窗口点「缩小 / 关闭」时由 DSH 发起）----
function workflowName() {
  try {
    const fromUrl = new URLSearchParams(location.search).get("dshWorkflow");
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore */
  }
  const active = app.workflowManager?.activeWorkflow;
  const name = active?.value?.name ?? active?.name ?? active?.path;
  if (name) return String(name);
  return "V5-Anima_miaomiaoHarem_anima.json";
}

async function saveWorkflow() {
  const active = app.workflowManager?.activeWorkflow;
  if (active && typeof active.save === "function") {
    await active.save();
    return "workflowManager";
  }
  const graph = typeof app.graph?.serialize === "function" ? app.graph.serialize() : null;
  if (!graph) throw new Error("画布没有 serialize 方法");
  const name = workflowName();
  const res = await fetch("/api/userdata/workflows%2F" + encodeURIComponent(name), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(graph),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return "userdata:" + name;
}

// ---- 模块顶层就报到：只要这段脚本被执行，父窗口立刻能收到 ----
post({ type: "aw:hello", phase: "module", search: String(location.search || ""), inFrame: window.parent !== window });
showBadge("dsh-bridge 已执行\n等待 ComfyUI 初始化…");

app.registerExtension({
  name: "dsh.anima.bridge",
  async setup() {
    const hasFlag = new URLSearchParams(location.search).has(AUTO_FLAG);
    post({
      type: "aw:hello",
      phase: "setup",
      search: String(location.search || ""),
      nodes: animaNodes().length,
      panelShown: panelShown(),
    });
    showBadge(`dsh-bridge setup\n节点 ${animaNodes().length} · 面板 ${panelShown() ? "开" : "关"}\n?dshPanel=${hasFlag ? 1 : 0} · 已发 ${sent} 条`);

    setInterval(() => {
      const data = collectState();
      if (data) post({ type: "aw:state", data });
      showBadge(`dsh-bridge 运行中\n节点 ${animaNodes().length} · 面板 ${panelShown() ? "开" : "关"}\n?dshPanel=${hasFlag ? 1 : 0} · 已发 ${sent} 条`);
    }, 2000);

    window.addEventListener("message", async (event) => {
      const data = event?.data;
      if (!data || data.source !== "dsh-anima-host" || data.type !== "aw:save") return;
      try {
        const how = await saveWorkflow();
        post({ type: "aw:saved", how });
        showBadge(`dsh-bridge 已保存工作流\n${how}`);
      } catch (error) {
        post({ type: "aw:save-fail", detail: String((error && error.message) || error) });
        showBadge(`dsh-bridge 保存失败\n${String((error && error.message) || error)}`);
      }
    });

    if (!hasFlag) return;

    const wfName = new URLSearchParams(location.search).get("dshWorkflow");
    if (wfName) {
      try {
        const res = await fetch("/api/userdata/workflows%2F" + encodeURIComponent(wfName), { cache: "no-store" });
        if (!res.ok) {
          post({ type: "aw:error", detail: `读工作流失败 ${res.status}：${wfName}` });
        } else {
          const graph = await res.json();
          await app.loadGraphData(graph, true, false, true);
          post({ type: "aw:workflow", name: wfName });
          showBadge(`dsh-bridge 已载入工作流\n${wfName}`);
        }
      } catch (error) {
        post({ type: "aw:error", detail: `载入工作流异常：${String((error && error.message) || error)}` });
      }
    }

    let tries = 0;
    const tick = () => {
      if (tryOpen()) {
        showBadge(`dsh-bridge 已打开面板\n尝试 ${tries} 次 · 已发 ${sent} 条`);
        return;
      }
      tries += 1;
      if (tries < 240) {
        setTimeout(tick, 500);
      } else {
        post({
          type: "aw:error",
          detail: `120 秒内没能打开面板（节点 ${animaNodes().length} 个，按钮 ${findButton(animaNodes()[0]) ? "有" : "无"}）`,
        });
        showBadge(`dsh-bridge 超时\n节点 ${animaNodes().length} · 按钮 ${findButton(animaNodes()[0]) ? "有" : "无"}`);
      }
    };
    setTimeout(tick, 500);
  },
});