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
    fundamentalResearch: {},
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
