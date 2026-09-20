import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, discoverAIStock } from "./settings";
import { parseInput, JobStore } from "./jobs";
import { classify } from "./model";
import { demoContext, demoResponse } from "./demo";
import { bridge } from "./python";

const input = { symbol: "600519", mode: "live", horizon: 5, position: "flat", costPercent: 0.3,
  execution: "next_session_open", instructions: "" };
const config = { horizon: "5 trading days", execution_assumption: "next_session_open", cost_assumption: "0.3% example",
  position: {state: "flat"}, request_timeout_seconds: 30, validity_seconds: 3600 };

test("settings never expose key and use private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-settings-"));
  try {
    const settings = new SettingsStore(dir);
    settings.save({ apiKey: "secret-for-test", model: "test-model" });
    expect(settings.read().apiKey).toBe("secret-for-test");
    expect(JSON.stringify(settings.public())).not.toContain("secret-for-test");
    expect(statSync(settings.path).mode & 0o777).toBe(0o600);
    settings.save({ apiKey: "", model: "second-model" });
    expect(settings.read().apiKey).toBe("secret-for-test");
    expect(readFileSync(settings.path, "utf8")).toContain("second-model");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("local checkout discovery supports the moved reference directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-discover-"));
  const previous = process.env.AISTOCK_PATH;
  delete process.env.AISTOCK_PATH;
  try {
    const source = join(dir, "AI-Stock/src/core"); mkdirSync(source, {recursive: true});
    writeFileSync(join(source, "pipeline.py"), "# fixture");
    expect(discoverAIStock(join(dir, "reference/jev-trading"))).toBe(join(dir, "AI-Stock"));
  } finally { if (previous !== undefined) process.env.AISTOCK_PATH = previous; rmSync(dir, {recursive: true, force: true}); }
});

test("job input validates symbols, modes and finite costs", () => {
  expect(parseInput(input).symbol).toBe("600519");
  expect(parseInput({...input, mode: "demo", symbol: "ignored"}).symbol).toBe("DEMO");
  for (const bad of [{symbol: "a; rm -rf"}, {mode: "other"}, {costPercent: NaN}, {horizon: 0}, {position: "short"}]) {
    expect(() => parseInput({...input, ...bad})).toThrow();
  }
});

test("job history survives restart and interrupted jobs are explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-jobs-"));
  try {
    const db = join(dir, "jobs.sqlite");
    const store = new JobStore(db), job = store.create(parseInput(input), "request-123");
    expect(store.byToken("request-123")?.id).toBe(job.id);
    store.db.close();
    const resumed = new JobStore(db);
    expect(resumed.get(job.id)?.state).toBe("failed");
    expect(resumed.get(job.id)?.message).toContain("中断");
    resumed.db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("reference SDK sends real Choice contract and preserves provider response", async () => {
  let calls = 0;
  const raw = {...demoResponse(), model: "jev-resolved-test", usage: { input_tokens: 100, output_tokens: 8 }};
  const fakeFetch = Object.assign(async (url: any, init: any) => {
    calls++;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sdk-test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("jev-requested");
    expect(body.questions.action.type).toBe("choice");
    expect(Object.keys(body.questions.action.criteria)).toEqual(["buy", "sell", "hold"]);
    return Response.json(raw);
  }, { preconnect: fetch.preconnect });
  const context = demoContext();
  const prepared = await bridge({operation: "prepare", context, config, model: "jev-requested"});
  const result = await classify(prepared.request, "sdk-test-key", 1000, fakeFetch);
  expect(result.raw).toEqual(raw);
  expect(calls).toBe(1);
});

test("SDK failures are not retried", async () => {
  let calls = 0;
  const fakeFetch = Object.assign(async () => { calls++; return new Response("Unauthorized", {status: 401}); }, { preconnect: fetch.preconnect });
  const prepared = await bridge({operation: "prepare", context: demoContext(), config, model: "jev"});
  await expect(classify(prepared.request, "test", 1000, fakeFetch)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("Bun to Python bridge persists a correctly labelled demo decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-bridge-"));
  try {
    const signal = await bridge({operation: "complete", context: demoContext(), config,
      model: "demo", response: demoResponse(), demo: true, latency_ms: 123,
      job_id: "test-job", database: join(dir, "decisions.db")});
    expect(signal.model_source).toBe("recorded");
    expect(signal.final_action).toBe("hold");
    expect(signal.status).toBe("accepted");
    expect(signal.latency_ms).toBe(123);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
