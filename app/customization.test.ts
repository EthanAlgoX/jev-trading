import { test, expect } from "bun:test";
import { StrategyStore } from "./customization";
import { apiInput } from "./api";
import { demoContext } from "./demo";

test("strategy versions persist and validation prevents empty or oversized prompts", () => {
  const store = new StrategyStore(":memory:");
  try {
    const first = store.save({name: "趋势", instructions: "优先考虑趋势"});
    const second = store.save({id: first.id, name: "趋势", instructions: "加入成交量"});
    expect(first.version).toBe(1); expect(second.version).toBe(2);
    expect(store.get(first.id)?.instructions).toBe("加入成交量");
    expect(() => store.save({name: "", instructions: "x"})).toThrow();
    expect(() => store.save({name: "x", instructions: "x".repeat(8001)})).toThrow();
    expect(() => store.save({id: "unknown", name: "x", instructions: "x"})).toThrow();
    expect(store.delete(first.id)).toBe(true); expect(store.get(first.id)).toBeUndefined();
  } finally { store.db.close(); }
});
test("collection and supplied contexts reject ambiguous or malformed inputs", () => {
  const base = {symbol: "DEMO", position: "flat"};
  expect(apiInput({...base, collection:{news:false,realtimeSources:["tencent","akshare_sina"]}}).input.collection?.news).toBe(false);
  for (const collection of [null,[],{news:"false"},{fundamentals:false},{realtimeSources:[]},{realtimeSources:["tencent","tencent"]},{realtimeSources:["unknown"]}])
    expect(() => apiInput({...base, collection})).toThrow();
  expect(() => apiInput({...base,mode:"demo",collection:{news:false}})).toThrow();
  expect(() => apiInput({...base,context:demoContext(),collection:{}})).toThrow();
  expect(() => apiInput({...base,symbol:"AAPL",context:demoContext()})).toThrow();
  expect(apiInput({...base,context:demoContext()}).input.context?.symbol).toBe("DEMO");
});
