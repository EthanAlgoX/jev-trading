import type { Job } from "../app/jobs";

const el = (id: string) => document.getElementById(id)!;
const field = (id: string) => el(id) as HTMLInputElement;
const button = (id: string) => el(id) as HTMLButtonElement;
const show = (id: string, visible: boolean) => { el(id).hidden = !visible; };
const text = (id: string, value: string) => { el(id).textContent = value; };
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
let mode: "demo" | "live" = "demo";
let status: any = null;
let jobs: Job[] = [];
let selected = localStorage.getItem("jev-selected") || "";
let submitting = false;
let realSymbol = "600519";
let pendingSubmission: { token: string; body: string } | null = null;
const actions: Record<string, string> = { buy: "买入", sell: "卖出", hold: "观望" };
const statuses: Record<string, string> = { accepted: "通过校验", blocked: "已限制动作", skipped: "数据未就绪", error: "模型调用失败", expired: "信号已过期" };
const dataNames: Record<string, string> = { quote: "实时行情", daily_bars: "历史行情", technical: "技术指标", fundamentals: "基本面", news: "新闻资讯", chip: "筹码分布", portfolio: "持仓信息" };
const dataStates: Record<string, string> = { available: "可用", partial: "部分可用", estimated: "估算", missing: "缺失", not_supported: "不支持", fetch_failed: "获取失败", fallback: "备用来源", stale: "已过期" };
const reasons: Record<string, string> = {
  CONSERVATIVE_MARKET: "大盘环境偏谨慎，本次不增加仓位。", HOLDING_CONTEXT_REQUIRED: "缺少明确持仓状态，暂不改变仓位。",
  NO_LONG_POSITION: "当前为空仓，不能执行卖出。", BUY_NOT_ALLOWED: "当前账户约束不允许买入。", SELL_NOT_ALLOWED: "当前账户约束不允许卖出。",
  BAR_DATE_MISMATCH: "行情日期与最近有效交易日不一致，请重新采集。", UNKNOWN_BAR_DATE: "无法确定行情日期，暂不生成买卖信号。",
  MARKET_NOT_OPEN: "当前不是交易时段；可将执行假设改为下一交易日开盘。", LIVE_QUOTE_UNAVAILABLE: "即刻执行需要可用的实时行情。",
  UNKNOWN_QUOTE_TIME: "实时行情缺少可验证的时间，暂不生成即刻交易信号。", STALE_QUOTE: "实时行情已过期，请重新分析。",
  CONTEXT_EXPIRED: "分析数据已过期，请重新分析。", FUTURE_CONTEXT: "数据时间异常，请检查系统时钟和数据源。",
  MODEL_TIMEOUT: "Jev 响应超时，请稍后重新分析。", MODEL_HTTP_401: "Jev 密钥未通过验证，请检查连接设置。",
  MODEL_HTTP_403: "Jev 拒绝访问，请检查账户权限。", MODEL_HTTP_429: "Jev 请求额度或频率受限，请稍后重试。",
  MODEL_REQUEST_FAILED: "Jev 请求未成功，请检查密钥、网络和模型名称。", INVALID_MODEL_RESPONSE: "模型未返回有效的三类动作概率，本次不采用该结果。",
  LATE_MODEL_RESPONSE: "模型返回时信号已过期，本次不采用动作。", SIGNAL_EXPIRED: "该历史信号已过期，请重新分析。",
};
function reasonLabel(code: string) {
  if (reasons[code]) return reasons[code];
  if (code.startsWith("DEGRADED_")) return `${dataNames[code.slice(9).toLowerCase()] || "核心数据"}不完整，本次不增加仓位。`;
  if (code.startsWith("UNUSABLE_")) return `${dataNames[code.slice(9).toLowerCase()] || "核心数据"}不可用，已跳过模型判断。`;
  return `校验未通过：${code}`;
}
function time(value: string, full = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", full ? { hour12: false } : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function expired(job: Job) { return job.result && Date.parse(job.result.valid_until) <= Date.now(); }
function busy() { return submitting || jobs.some(j => !["done", "failed"].includes(j.state)); }
async function api(path: string, body?: unknown, token?: string) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: {
    ...(body === undefined ? {} : { "content-type": "application/json", "x-jev-request": "1" }),
    ...(token ? { "idempotency-key": token } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败，请重试。");
  return result;
}
function setSettings(open: boolean) {
  show("settings-panel", open);
  button("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) { el("settings-panel").scrollIntoView({ block: "start", behavior: "auto" }); field("api-key").focus(); }
}
function refreshControls() {
  button("demo-mode").setAttribute("aria-pressed", String(mode === "demo"));
  button("live-mode").setAttribute("aria-pressed", String(mode === "live"));
  if (mode === "demo" && field("symbol").value !== "DEMO") { realSymbol = field("symbol").value; field("symbol").value = "DEMO"; }
  if (mode === "live" && field("symbol").value === "DEMO") field("symbol").value = realSymbol;
  field("symbol").disabled = mode === "demo" || busy();
  text("mode-help", mode === "demo" ? "无需密钥，用合成样本体验完整决策流程。" : "使用 AIStock 实时采集的数据，由 Jev 进行分类判断。");
  text("submit-note", mode === "demo" ? "演示使用合成数据与固定响应，不调用 Jev。" : "仅生成决策信号，不会发出任何交易订单。");
  show("live-blocker", mode === "live" && !status?.ready);
  button("analyze").disabled = busy() || !(mode === "demo" ? status?.demoReady : status?.ready);
  button("analyze").innerHTML = busy() ? "分析正在进行…" : `${mode === "demo" ? "体验一次决策" : "开始分析"} <span aria-hidden="true">→</span>`;
  button("save-settings").disabled = busy();
}
async function loadStatus() {
  status = await api("/api/status");
  field("model").value = status.settings.model;
  field("aistock-path").value = status.settings.aistockPath;
  field("aistock-python").value = status.settings.aistockPython;
  field("api-key").placeholder = status.settings.configured ? "已配置；留空保持现有密钥" : "填写 Jev API Key";
  el("checks").innerHTML = status.checks.map((check: any) => `<li class="${check.ok ? "ok" : "not-ready"}" title="${escape(check.hint)}">${check.ok ? "✓" : "○"} ${escape(check.label)}${check.ok ? "" : "（待配置）"}</li>`).join("");
  refreshControls();
}
function choose(job: Job) {
  selected = job.id; localStorage.setItem("jev-selected", selected);
  render();
}
function renderResult() {
  const job = jobs.find(j => j.id === selected);
  show("empty-state", !job);
  for (const id of ["progress-state", "result-content", "failed-state"]) show(id, false);
  text("result-badge", !job ? "等待分析" : job.mode === "demo" ? "演示样本" : "真实分析");
  el("result-badge").className = `tag ${job?.mode === "live" ? "live" : ""}`;
  document.querySelector(".result-panel")!.setAttribute("aria-busy", String(!!job && !["done", "failed"].includes(job.state)));
  if (!job) return;
  if (job.state === "failed") { show("failed-state", true); text("failure-message", job.message); return; }
  if (job.state !== "done") {
    show("progress-state", true); text("progress-symbol", job.mode === "demo" ? "演示股票" : job.symbol); text("progress-title", job.message);
    (el("progress") as HTMLProgressElement).value = job.progress;
    el("stage-collect").className = job.state === "collecting" || job.state === "queued" ? "current" : "";
    el("stage-model").className = job.state === "evaluating" ? "current" : "";
    el("stage-policy").className = job.state === "validating" ? "current" : "";
    return;
  }
  show("result-content", true);
  const signal = job.result, isExpired = expired(job);
  const action = isExpired ? "hold" : signal.final_action;
  const signalStatus = isExpired ? "expired" : signal.status;
  text("result-symbol", `${job.mode === "demo" ? "DEMO · 演示股票" : job.symbol} / ${job.input.position === "flat" ? "当前空仓" : "当前持有"}`);
  text("action", actions[action] || "未形成动作"); el("action").className = action;
  text("status-label", statuses[signalStatus] || signalStatus);
  const original = actions[signal.model_action];
  text("decision-explanation", isExpired ? `这是历史记录，原最终动作是${actions[signal.final_action]}。请重新分析后再使用。`
    : signal.model_action === null ? "未取得可采用的模型判断，本次维持当前状态。"
    : signal.model_action !== signal.final_action ? `模型建议${original}，程序校验后调整为${actions[signal.final_action]}。`
    : action === "hold" ? "当前建议保持持仓状态，等待更明确的信号。" : `模型建议${original}，已通过本次信号校验；实际交易前仍需核对账户与执行条件。`);
  show("demo-disclosure", job.mode === "demo");
  const codes = [...(signal.reason_codes || []), ...(isExpired ? ["SIGNAL_EXPIRED"] : [])];
  el("reason-list").innerHTML = [...new Set(codes)].map(c => `<p>${escape(reasonLabel(c as string))}</p>`).join("");
  el("probability-bars").innerHTML = signal.action_probabilities
    ? ["buy", "sell", "hold"].map(side => { const p = Math.max(0, Math.min(100, Number(signal.action_probabilities[side]) * 100));
      return `<div class="probability-row ${side}"><span class="probability-label">${actions[side]}</span><div class="probability-track" aria-hidden="true"><div class="probability-fill" style="width:${p}%"></div></div><span class="probability-number">${p.toFixed(0)}%</span></div>`; }).join("")
    : '<p class="help">本次没有有效的模型概率，不以零值代替。</p>';
  el("quality").innerHTML = Object.entries(job.quality || {}).map(([name, value]) => `<div><dt>${escape(dataNames[name] || name)}</dt><dd class="${value === "available" ? "" : "degraded"}">${escape(dataStates[value] || value)}</dd></div>`).join("");
  text("data-subtitle", job.mode === "demo" ? "合成示例" : "保留缺失与降级状态");
  text("result-horizon", `未来 ${job.input.horizon} 个交易日`);
  text("result-model", job.mode === "demo" ? "固定演示响应（未调用 Jev）" : signal.resolved_model || signal.requested_model);
  text("result-time", time(signal.created_at, true));
  text("result-expiry", time(signal.valid_until, true));
  (el("export") as HTMLAnchorElement).href = `/api/jobs/${job.id}/export`;
}
function renderHistory() {
  text("history-count", jobs.length ? `${jobs.length} 条记录` : "");
  show("history-empty", !jobs.length);
  el("history-body").innerHTML = jobs.map(job => {
    const isExpired = expired(job), action = job.result?.final_action;
    const stateLabel = job.state === "failed" ? "未完成" : job.state === "done" ? statuses[isExpired ? "expired" : job.result.status] : "进行中";
    return `<tr class="${job.id === selected ? "selected" : ""}"><td><button class="text-button" data-job="${job.id}">${escape(job.symbol === "DEMO" ? "演示股票" : job.symbol)}</button></td><td>${job.mode === "demo" ? "演示" : "真实"}</td><td class="${escape(action || "")}">${actions[action] || "等待结果"}</td><td>${escape(stateLabel)}</td><td>${time(job.createdAt)}</td><td><button class="text-button" data-job="${job.id}" aria-label="查看 ${escape(job.symbol)} 的分析">查看 ↗</button></td></tr>`;
  }).join("");
}
function render() { renderResult(); renderHistory(); refreshControls(); }
function upsert(job: Job) { jobs = [job, ...jobs.filter(j => j.id !== job.id)].sort((a,b) => b.createdAt.localeCompare(a.createdAt)); render(); }
button("settings-toggle").onclick = () => setSettings(el("settings-panel").hidden);
for (const id of ["open-setup", "failure-settings"]) button(id).onclick = () => setSettings(true);
button("close-settings").onclick = () => { setSettings(false); button("settings-toggle").focus(); };
button("demo-mode").onclick = () => { mode = "demo"; refreshControls(); };
button("live-mode").onclick = () => { mode = "live"; refreshControls(); };
el("settings-form").addEventListener("submit", async event => {
  event.preventDefault(); button("save-settings").disabled = true; text("settings-feedback", "正在保存…");
  try {
    await api("/api/settings", { apiKey: field("api-key").value, model: field("model").value,
      aistockPath: field("aistock-path").value, aistockPython: field("aistock-python").value });
    field("api-key").value = ""; await loadStatus();
    text("settings-feedback", status.ready ? "已保存，真实分析已就绪。" : "已保存。请完成上方标注的待配置项。");
  } catch (error: any) { text("settings-feedback", error.message); }
  finally { button("save-settings").disabled = busy(); }
});
el("stock-form").addEventListener("submit", async event => {
  event.preventDefault(); if (busy()) return;
  const input = { symbol: field("symbol").value, mode, horizon: Number(field("horizon").value), position: field("position").value,
    execution: field("execution").value, costPercent: Number(field("cost").value), instructions: field("instructions").value };
  const body = JSON.stringify(input);
  if (pendingSubmission?.body !== body) pendingSubmission = { token: crypto.randomUUID(), body };
  submitting = true; refreshControls(); show("global-error", false);
  try { const job = await api("/api/jobs", input, pendingSubmission.token); upsert(job); choose(job); pendingSubmission = null; }
  catch (error: any) { text("global-error", error.message || "无法连接，请稍后重试。"); show("global-error", true); }
  finally { submitting = false; refreshControls(); }
});
el("history-body").addEventListener("click", event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-job]");
  const job = target && jobs.find(j => j.id === target.dataset.job); if (job) { choose(job); el("result-title").scrollIntoView({ block: "start", behavior: "auto" }); }
});
async function initialize() {
  try { await loadStatus(); jobs = await api("/api/jobs"); if (!jobs.some(j => j.id === selected)) selected = jobs[0]?.id || ""; render(); }
  catch { text("global-error", "无法连接本地服务，请检查启动终端，刷新页面重试。"); show("global-error", true); }
  const feed = new EventSource("/api/events");
  feed.addEventListener("open", () => { show("connection-error", false); });
  feed.addEventListener("error", () => show("connection-error", true));
  feed.addEventListener("snapshot", event => { jobs = JSON.parse((event as MessageEvent).data); if (!selected) selected = jobs[0]?.id || ""; render(); });
  feed.addEventListener("job", event => { const job = JSON.parse((event as MessageEvent).data); if (!selected) selected = job.id; upsert(job); });
  setInterval(() => { renderResult(); renderHistory(); }, 30_000);
}
void initialize();
