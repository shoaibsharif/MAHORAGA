import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, ResearchResult, Signal } from "../core/types";
import type { Env } from "../env.d";
import { getFundamentalContext } from "../providers/fundamentals";
import { type HalalReport, unknownHalalReport } from "../providers/halal";
import { DEFAULT_STATE } from "../strategy/default/config";
import type { StrategyContext } from "../strategy/types";
import { MahoragaHarness } from "./mahoraga-harness";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("../providers/fundamentals", () => ({ getFundamentalContext: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function passing(symbol: string): HalalReport {
  return {
    ...unknownHalalReport(symbol, "Test evidence"),
    assetType: "stock",
    status: "compliant",
    screenedAt: new Date().toISOString(),
  };
}

function signal(symbol: string, sentiment: number): Signal {
  return {
    symbol,
    sentiment,
    raw_sentiment: sentiment,
    source: "test",
    source_detail: "test",
    volume: 20,
    freshness: 1,
    source_weight: 1,
    reason: "Dynamic signal",
    timestamp: Date.now(),
  };
}

function setup() {
  const complete = vi.fn().mockResolvedValue({
    content: JSON.stringify({
      verdict: "BUY",
      confidence: 0.9,
      entry_quality: "good",
      reasoning: "Test research",
      red_flags: [],
      catalysts: [],
    }),
  });
  const screen = vi.fn(async (symbol: string) => passing(symbol));
  const state: AgentState = {
    ...structuredClone(DEFAULT_STATE),
    signalCache: [],
    signalResearch: {},
    halalReports: {},
  };
  const harness = Object.assign(Object.create(MahoragaHarness.prototype), {
    state,
    _llm: { complete },
    screening: { screen },
    env: {} as Env,
    log: vi.fn(),
    sleep: vi.fn(),
    sendDiscordNotification: vi.fn(),
    trackLLMCost: vi.fn(),
  }) as MahoragaHarness;
  const ctx = {
    config: state.config,
    positionEntries: {},
    state: { get: vi.fn() },
    broker: { getPositions: vi.fn().mockResolvedValue([]) },
  } as unknown as StrategyContext;
  return { harness, state, complete, screen, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          latestTrade: { p: 100 },
          latestQuote: { ap: 100 },
          dailyBar: {},
          prevDailyBar: {},
          minuteBar: {},
        })
      )
    )
  );
  vi.mocked(getFundamentalContext).mockImplementation(async (_env, symbol) => ({
    symbol,
    company: "Test issuer",
    checkedAt: new Date().toISOString(),
    sourceUrl: "https://data.sec.gov/test",
    metrics: {},
    filings: [],
    limitations: ["Test financial facts unavailable"],
  }));
});

describe("trade alerts", () => {
  type Notifier = {
    notifyTrade(
      side: "buy" | "sell",
      symbol: string,
      details: { notional?: number; reason: string; pnl?: number | null }
    ): Promise<void>;
  };

  it("sends every executed buy and sell to Discord with the amount, result and account type", async () => {
    const { harness } = setup();
    const post = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", post);
    Object.assign(harness, { env: { DISCORD_WEBHOOK_URL: "https://discord.test/hook", ALPACA_PAPER: "true" } });
    const notifier = harness as unknown as Notifier;

    await notifier.notifyTrade("buy", "TEST", { notional: 7.18, reason: "Research BUY" });
    await notifier.notifyTrade("sell", "TEST", { reason: "Stop loss", pnl: -1.5 });

    expect(post).toHaveBeenCalledTimes(2);
    const [bought, sold] = post.mock.calls.map((call) => JSON.parse(call[1].body).embeds[0]);
    expect(bought.title).toBe("Bought $TEST");
    expect(bought.fields).toEqual([
      { name: "Amount", value: "$7.18", inline: true },
      { name: "Account", value: "Paper", inline: true },
    ]);
    expect(sold.title).toBe("Sold $TEST");
    expect(sold.fields[0]).toEqual({ name: "Profit or loss", value: "-$1.50", inline: true });
  });

  it("stays silent without a webhook and survives a Discord failure", async () => {
    const { harness } = setup();
    const post = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", post);
    const notifier = harness as unknown as Notifier;
    await notifier.notifyTrade("buy", "TEST", { notional: 5, reason: "Research BUY" });
    expect(post).not.toHaveBeenCalled();

    Object.assign(harness, { env: { DISCORD_WEBHOOK_URL: "https://discord.test/hook" } });
    await expect(notifier.notifyTrade("buy", "TEST", { notional: 5, reason: "Research BUY" })).resolves.toBeUndefined();
  });
});

describe("dynamic screened research", () => {
  it("continues past rejected symbols and researches the next eligible stock", async () => {
    const { harness, state, complete, screen, ctx } = setup();
    state.signalCache = [signal("REJECT", 0.9), signal("DYNAMIC", 0.8)];
    screen.mockImplementation(async (symbol) =>
      symbol === "REJECT" ? { ...passing(symbol), status: "non_compliant" } : passing(symbol)
    );
    const results = await (
      harness as unknown as { researchTopSignals(ctx: StrategyContext, limit: number): Promise<ResearchResult[]> }
    ).researchTopSignals(ctx, 1);
    expect(results.map((result) => result.symbol)).toEqual(["DYNAMIC"]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0].messages[1].content).toContain("SEC FINANCIAL CONTEXT");
  });

  it("removes a cached BUY when the stock no longer passes screening", async () => {
    const { harness, state, complete, screen, ctx } = setup();
    state.signalResearch.TEST = {
      symbol: "TEST",
      verdict: "BUY",
      confidence: 1,
      entry_quality: "excellent",
      reasoning: "Earlier decision",
      catalysts: [],
      red_flags: [],
      timestamp: Date.now(),
    };
    state.signalCache = [signal("TEST", 0.9)];
    screen.mockResolvedValue(unknownHalalReport("TEST", "Provider unavailable"));
    await (
      harness as unknown as { researchTopSignals(ctx: StrategyContext, limit: number): Promise<ResearchResult[]> }
    ).researchTopSignals(ctx, 1);
    expect(state.signalResearch.TEST).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("drops a failed screening once its symbol stops being rescreened, but keeps one for a held position", async () => {
    const { harness, state, ctx } = setup();
    const hourAgo = Date.now() - 3_600_000;
    state.halalReports.GONE = unknownHalalReport("GONE", "Provider unavailable", hourAgo);
    state.halalReports.HELD = unknownHalalReport("HELD", "Provider unavailable", hourAgo);
    state.halalReports.RECENT = unknownHalalReport("RECENT", "Provider unavailable");
    state.positionEntries.HELD = {} as AgentState["positionEntries"][string];
    state.signalCache = [signal("DYNAMIC", 0.9)];
    await (
      harness as unknown as { researchTopSignals(ctx: StrategyContext, limit: number): Promise<ResearchResult[]> }
    ).researchTopSignals(ctx, 1);
    expect(Object.keys(state.halalReports).sort()).toEqual(["DYNAMIC", "HELD", "RECENT"]);
  });

  it("does not call the analyst model when no research says BUY and nothing is held", async () => {
    const { harness, state, complete, ctx } = setup();
    state.signalCache = [signal("DYNAMIC", 0.9)];
    state.signalResearch.DYNAMIC = {
      symbol: "DYNAMIC",
      verdict: "WAIT",
      confidence: 0.8,
      entry_quality: "fair",
      reasoning: "Current research",
      catalysts: [],
      red_flags: [],
      timestamp: Date.now(),
    };
    state.halalReports.DYNAMIC = passing("DYNAMIC");
    const result = await (
      harness as unknown as {
        callAnalystLLM(
          ctx: StrategyContext,
          signals: Signal[],
          positions: unknown[],
          account: unknown
        ): Promise<{ recommendations: unknown[] }>;
      }
    ).callAnalystLLM(ctx, state.signalCache, [], { cash: 100, equity: 100 });
    expect(result.recommendations).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("calls the analyst model once per new BUY research, not every cycle", async () => {
    const { harness, state, complete, ctx } = setup();
    state.signalCache = [signal("DYNAMIC", 0.9)];
    state.signalResearch.DYNAMIC = {
      symbol: "DYNAMIC",
      verdict: "BUY",
      confidence: 0.9,
      entry_quality: "good",
      reasoning: "Current research",
      catalysts: [],
      red_flags: [],
      timestamp: Date.now() - 1_000,
    };
    state.halalReports.DYNAMIC = passing("DYNAMIC");
    complete.mockResolvedValue({ content: JSON.stringify({ recommendations: [] }) });
    const analyst = harness as unknown as {
      callAnalystLLM(ctx: StrategyContext, signals: Signal[], positions: unknown[], account: unknown): Promise<unknown>;
    };
    await analyst.callAnalystLLM(ctx, state.signalCache, [], { cash: 100, equity: 100 });
    // Research refreshed a minute later is still the same candidate.
    state.signalResearch.DYNAMIC.timestamp = Date.now() + 60_000;
    await analyst.callAnalystLLM(ctx, state.signalCache, [], { cash: 100, equity: 100 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(state.lastAnalystModelCall).toBeGreaterThan(0);
  });

  it("filters extra analyst BUY recommendations without preventing SELL recommendations", async () => {
    const { harness, state, complete, ctx } = setup();
    state.signalResearch.DYNAMIC = {
      symbol: "DYNAMIC",
      verdict: "BUY",
      confidence: 0.9,
      entry_quality: "good",
      reasoning: "Current research",
      catalysts: [],
      red_flags: [],
      timestamp: Date.now(),
    };
    state.halalReports.DYNAMIC = passing("DYNAMIC");
    complete.mockResolvedValue({
      content: JSON.stringify({
        recommendations: [
          { symbol: "DYNAMIC", action: "BUY", confidence: 0.9 },
          { symbol: "UNSCREENED", action: "BUY", confidence: 1 },
          { symbol: "UNSCREENED", action: "SELL", confidence: 1 },
        ],
      }),
    });
    const result = await (
      harness as unknown as {
        callAnalystLLM(...args: unknown[]): Promise<{ recommendations: Array<{ symbol: string; action: string }> }>;
      }
    ).callAnalystLLM(ctx, [signal("DYNAMIC", 0.9)], [], { cash: 100, equity: 100 });
    expect(result.recommendations).toEqual([
      expect.objectContaining({ symbol: "DYNAMIC", action: "BUY" }),
      expect.objectContaining({ symbol: "UNSCREENED", action: "SELL" }),
    ]);
  });
});

describe("selling a position", () => {
  type Seller = {
    sellPosition(ctx: StrategyContext, position: unknown, reason: string, kind: string): Promise<boolean>;
  };
  const MID_SESSION = "2026-11-12T16:00:00Z"; // 11:00 in New York
  const JUST_OPENED = "2026-11-12T14:40:00Z"; // 9:40 in New York

  function position(plPct: number) {
    return {
      symbol: "TEST",
      asset_class: "us_equity",
      qty: 1,
      avg_entry_price: 100,
      current_price: 100 + plPct,
      market_value: 100 + plPct,
      unrealized_pl: plPct,
    };
  }

  function selling(at: string, decision?: "SELL" | "HOLD") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    const made = setup();
    const sell = vi.fn().mockResolvedValue(true);
    Object.assign(made.ctx.broker, { sell });
    // Bought two days ago, so the same-day rule is not what holds a sale back.
    made.state.positionEntries.TEST = {
      symbol: "TEST",
      entry_time: Date.now() - 2 * 86_400_000,
      entry_reason: "Research BUY",
    } as AgentState["positionEntries"][string];
    if (decision) {
      made.complete.mockResolvedValue({ content: JSON.stringify({ decision, reasoning: `Model says ${decision}` }) });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("/news")
          ? new Response(
              JSON.stringify({
                news: [
                  {
                    id: 1,
                    headline: "Chief executive resigns",
                    source: "wire",
                    created_at: "2026-11-12T14:21:00Z",
                    symbols: ["TEST"],
                  },
                ],
              })
            )
          : new Response(JSON.stringify({ latestTrade: { p: 92 }, latestQuote: { ap: 92 }, bars: [] }))
      )
    );
    return { ...made, sell, seller: made.harness as unknown as Seller };
  }

  afterEach(() => vi.useRealTimers());

  it("keeps a position past the stop loss when the review says to hold, and shows the model the news", async () => {
    const { seller, ctx, sell, complete, state } = selling(MID_SESSION, "HOLD");

    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(false);
    expect(sell).not.toHaveBeenCalled();
    expect(complete.mock.calls[0]![0].messages[1].content).toContain("Chief executive resigns");
    expect(complete.mock.calls[0]![0].model).toBe(state.config.llm_analyst_model);
    expect(state.stopLossReviews.TEST).toMatchObject({ decision: "HOLD", plPct: -8 });

    // The next cycles reuse the decision; a loss three points deeper is reviewed afresh.
    await seller.sellPosition(ctx, position(-9), "Stop loss at -9.0%", "stop_loss");
    expect(complete).toHaveBeenCalledTimes(1);
    await seller.sellPosition(ctx, position(-11), "Stop loss at -11.0%", "stop_loss");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("sells with the review's reasoning when the review says to sell", async () => {
    const { seller, ctx, sell } = selling(MID_SESSION, "SELL");
    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(true);
    expect(sell).toHaveBeenCalledWith("TEST", "Stop loss at -8.0%. Reviewed with the news: Model says SELL");
  });

  it("holds the analyst's own sale of a losing position to the same review", async () => {
    const { seller, ctx, sell } = selling(MID_SESSION, "HOLD");
    expect(await seller.sellPosition(ctx, position(-8), "LLM recommendation: exit", "analyst")).toBe(false);
    expect(sell).not.toHaveBeenCalled();
  });

  it("sells at the hard stop without asking the model, even just after the open", async () => {
    const { seller, ctx, sell, complete } = selling(JUST_OPENED, "HOLD");
    expect(await seller.sellPosition(ctx, position(-16), "Stop loss at -16.0%", "stop_loss")).toBe(true);
    expect(sell).toHaveBeenCalledWith("TEST", "Stop loss at -16.0%");
    expect(complete).not.toHaveBeenCalled();
  });

  it("waits out the opening minutes before any other sale", async () => {
    const { seller, ctx, sell, complete } = selling(JUST_OPENED, "SELL");
    expect(await seller.sellPosition(ctx, position(12), "Take profit at +12.0%", "take_profit")).toBe(false);
    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(false);
    expect(sell).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-11-12T15:00:00Z"));
    expect(await seller.sellPosition(ctx, position(12), "Take profit at +12.0%", "take_profit")).toBe(true);
    expect(sell).toHaveBeenCalledWith("TEST", "Take profit at +12.0%");
  });

  it("sells a stale position without a review", async () => {
    const { seller, ctx, sell, complete } = selling(MID_SESSION, "HOLD");
    expect(await seller.sellPosition(ctx, position(-8), "STALE: held 4.0 days", "stale")).toBe(true);
    expect(sell).toHaveBeenCalledWith("TEST", "STALE: held 4.0 days");
    expect(complete).not.toHaveBeenCalled();
  });

  it("retries a failed review, then falls back to the stop loss after fifteen minutes", async () => {
    const { seller, ctx, sell, complete } = selling(MID_SESSION);
    complete.mockRejectedValue(new Error("model unavailable"));

    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(false);
    vi.setSystemTime(new Date(Date.parse(MID_SESSION) + 10 * 60_000));
    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(false);
    expect(sell).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(Date.parse(MID_SESSION) + 16 * 60_000));
    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(true);
    expect(sell).toHaveBeenCalledWith("TEST", "Stop loss at -8.0% (the review could not be completed)");
  });

  it("does not accept an answer that is neither SELL nor HOLD as a decision", async () => {
    const { seller, ctx, sell, complete, state } = selling(MID_SESSION);
    complete.mockResolvedValue({ content: JSON.stringify({ decision: "MAYBE", reasoning: "Unsure" }) });
    expect(await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss")).toBe(false);
    expect(state.stopLossReviews.TEST).toBeUndefined();
    expect(sell).not.toHaveBeenCalled();
  });

  it("leaves shares bought today to the broker's settlement rule without spending a review", async () => {
    const { seller, ctx, sell, complete, state } = selling(MID_SESSION, "HOLD");
    state.positionEntries.TEST!.entry_time = Date.now() - 3_600_000;
    await seller.sellPosition(ctx, position(-8), "Stop loss at -8.0%", "stop_loss");
    expect(sell).toHaveBeenCalledWith("TEST", "Stop loss at -8.0%");
    expect(complete).not.toHaveBeenCalled();
  });
});
