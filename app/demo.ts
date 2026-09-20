export function demoContext() {
  const now = new Date(), date = now.toISOString().slice(0, 10);
  const item = (value: unknown) => ({ status: "available", value, source: "synthetic_demo" });
  return { schema_version: "1", symbol: "DEMO", captured_at: now.toISOString(),
    market_is_conservative: false,
    provenance: { source: "synthetic_demo_not_market_data" },
    pack: { subject: { code: "DEMO", stock_name: "演示股票" },
      phase: { phase: "postmarket", effective_daily_bar_date: date, is_market_open_now: false },
      blocks: {
        quote: { status: "available", items: { price: item(102.6) } },
        daily_bars: { status: "available", metadata: { date }, items: { today: item({ close: 102.6 }) } },
        technical: { status: "available", items: { trend_result: item({ signal_score: 68, trend_status: "温和上行（示例）" }) } },
        fundamentals: { status: "available", items: { summary: item("收入与利润稳步增长（合成示例）") } },
        news: { status: "available", items: { content: item("未见重大负面事件（合成示例）") } },
        chip: { status: "missing", items: {} },
      } },
    enhanced_context: {}, history: [],
  };
}

export function demoResponse() {
  return { model: "offline-example-not-a-live-model", answers: { action: { type: "choice", choice: "hold",
    probabilities: { buy: 0.26, sell: 0.09, hold: 0.65 }, confidence: 0.4 } }, usage: {} };
}
