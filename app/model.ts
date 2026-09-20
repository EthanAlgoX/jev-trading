// SDK integration adapted from reference/src/model.ts (MIT, see reference/LICENSE).
import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";

export interface ModelRequest { model: string; state: string; questions: any }

export async function classify(request: ModelRequest, apiKey: string, timeoutMs: number, fetchImpl?: NonNullable<NonNullable<Parameters<typeof createTypeSafeAi>[0]>["fetch"]>) {
  const started = performance.now();
  const provider = createTypeSafeAi({ apiKey, fetch: fetchImpl });
  const response = await experimental_evaluate({
    model: provider.evaluationModel(request.model),
    state: request.state,
    questions: request.questions,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  // The SDK exposes the original response body; preserve confidence, usage and actual model.
  const raw = response.response.body;
  if (!raw || typeof raw !== "object") throw new Error("INVALID_MODEL_RESPONSE");
  return { raw, latencyMs: Math.round(performance.now() - started) };
}

import { methods } from "./backends";
import type { Settings } from "./settings";

export function inferenceMetadata(settings: Settings) {
  return { backend: settings.backend, probability_method: methods[settings.backend === "jev" ? "jev" : settings.localEngine],
    endpoint: settings.backend === "jev" ? "https://api.typesafe.ai/v1/systemone" : `${settings.localBaseUrl}/v1/systemone`,
    declared_model: settings.backend === "jev" ? null : settings.localModelId || null,
    declared_revision: settings.backend === "jev" ? null : settings.localRevision || null,
    reported_model: null as string | null };
}

export async function classifyWithBackend(request: ModelRequest, settings: Settings, fetchImpl: typeof fetch = fetch) {
  const inference = inferenceMetadata(settings);
  if (settings.backend === "jev") return { ...await classify(request, settings.apiKey, settings.modelTimeoutSeconds * 1000, fetchImpl), inference };
  const started = performance.now();
  // Cloud credentials are never sent to a local backend. Redirects are rejected.
  const response = await fetchImpl(inference.endpoint, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json", ...(settings.localApiKey ? { authorization: `Bearer ${settings.localApiKey}` } : {}) },
    body: JSON.stringify(request), signal: AbortSignal.timeout(settings.modelTimeoutSeconds * 1000) });
  if (!response.ok) throw Object.assign(new Error(`MODEL_HTTP_${response.status}`), {statusCode: response.status});
  const raw = await response.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_MODEL_RESPONSE");
  // OpenJev may echo an alias in raw.model; its header names the served model.
  // Preserve raw untouched and record the extra identity separately.
  inference.reported_model = response.headers.get("x-inference-model") || response.headers.get("x-openjev-model");
  return { raw, latencyMs: Math.round(performance.now() - started), inference };
}

export async function probeBackend(settings: Settings) {
  if (settings.backend === "jev") return { backend: "jev", reachable: null, message: "云端路径未发送测试推理；配置密钥后可提交分析。" };
  const path = settings.localEngine === "generated" ? "/ready" : "/health";
  try {
    const response = await fetch(settings.localBaseUrl + path, { redirect: "error", signal: AbortSignal.timeout(5000),
      headers: settings.localApiKey ? {authorization: `Bearer ${settings.localApiKey}`} : {} });
    if (!response.ok) return {backend: settings.backend, reachable: false, status: response.status};
    const body: any = await response.json();
    return {backend: settings.backend, reachable: body.status === (settings.localEngine === "generated" ? "ready" : "ok"), upstream_model: typeof body.upstream_model === "string" ? body.upstream_model : null,
      message: "就绪端点可访问；未执行分类推理。"};
  } catch { return {backend: settings.backend, reachable: false, message: "本地服务不可达、响应无效或探测超时。"}; }
}
