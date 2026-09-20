import { parseInput, type Job } from "./jobs";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function apiInput(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("INVALID_INPUT", "请求必须是 JSON 对象。");
  const allowed = ["symbol", "mode", "position", "horizon", "costPercent", "execution", "instructions", "waitSeconds", "backend", "localEngine"];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new ApiError("INVALID_INPUT", "存在未知参数，请参阅 docs/http-api.md。");
  const wait = body.waitSeconds ?? 25;
  if (!Number.isInteger(wait) || wait < 0 || wait > 25) throw new ApiError("INVALID_INPUT", "waitSeconds 应为 0 至 25 的整数。");
  const input = parseInput({ mode: "live", horizon: 5, costPercent: 0.3, execution: "next_session_open", instructions: "", ...body });
  return { input, wait };
}
export function decisionResponse(job: Job) {
  let decision = job.result ? structuredClone(job.result) : null;
  if (decision && Date.parse(decision.valid_until) <= Date.now()) {
    decision.final_action = "hold"; decision.status = "expired";
    decision.reason_codes = [...new Set([...decision.reason_codes, "DECISION_EXPIRED"])];
  }
  return { api_version: "1", request_id: job.id, state: job.state, mode: job.mode,
    inference_backend: job.backend ?? job.result?.model_source ?? null, progress: job.progress, message: job.message, decision,
    error: job.state === "failed" ? { code: "ANALYSIS_FAILED", message: job.message } : null,
    links: { self: `/v1/decisions/${job.id}`, evidence: `/v1/decisions/${job.id}/evidence` } };
}
export async function waitForJob(task: Promise<void> | undefined, seconds: number) {
  if (!task || !seconds) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([task, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); })]); }
  finally { clearTimeout(timer); }
}
