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
