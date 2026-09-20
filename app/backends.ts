export type Backend = "jev" | "local";
export type LocalEngine = "generated" | "logprobs";
export const methods = { jev: "provider_reported", generated: "generated_probabilities", logprobs: "label_logprobs" } as const;
export function backendName(value: unknown): Backend {
  if (value === "localjev" || value === "openjev_sglang") return "local"; // Legacy configuration migration.
  if (value !== "jev" && value !== "local") throw new Error("backend 必须为 jev 或 local。");
  return value;
}
export function engineName(value: unknown): LocalEngine {
  if (value === "localjev") return "generated";
  if (value === "openjev_sglang") return "logprobs";
  if (value !== "generated" && value !== "logprobs") throw new Error("localEngine 必须为 generated 或 logprobs。");
  return value;
}
export function legacyEngine(value: unknown): LocalEngine | undefined {
  return value === "localjev" ? "generated" : value === "openjev_sglang" ? "logprobs" : undefined;
}
export function localURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("本地模型地址不是有效 URL。"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("本地模型地址须为本机 HTTP(S) 服务根地址（可带 /v1），不得包含凭据、查询参数或其他路径。");
  }
  return url.origin;
}
