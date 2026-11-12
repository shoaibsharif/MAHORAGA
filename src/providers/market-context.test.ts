import { describe, expect, it } from "vitest";
import type { FundamentalContext } from "./fundamentals";
import {
  computeValuation,
  formatHeadlines,
  minutesSinceOpen,
  summarizePriceHistory,
  tradingSession,
} from "./market-context";
import type { Bar } from "./types";

function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    o: c,
    h: c * 1.01,
    l: c * 0.99,
    c,
    v: 1_000 + i,
    n: 10,
    vw: c,
  }));
}

function fundamentals(overrides: Partial<FundamentalContext> = {}): FundamentalContext {
  return {
    symbol: "TEST",
    company: "Test",
    checkedAt: new Date().toISOString(),
    sourceUrl: null,
    metrics: {},
    filings: [],
    limitations: [],
    sharesOutstanding: { value: 1_000_000, end: "2026-10-01", filed: "2026-10-30" },
    annual: {
      revenue: {
        concept: "Revenues",
        value: 50_000_000,
        unit: "USD",
        start: "2025-01-01",
        end: "2025-12-31",
        filed: "2026-02-01",
      },
      netIncome: {
        concept: "NetIncomeLoss",
        value: 5_000_000,
        unit: "USD",
        start: "2025-01-01",
        end: "2025-12-31",
        filed: "2026-02-01",
      },
    },
    ...overrides,
  };
}

describe("price history summary", () => {
  it("measures returns, distance from the range and moving averages", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const summary = summarizePriceHistory(bars(closes));
    expect(summary?.tradingDays).toBe(80);
    expect(summary?.lastClose).toBe(179);
    expect(summary?.returnPct.d5).toBe(2.87);
    expect(summary?.returnPct.d60).toBe(50.42);
    expect(summary?.vsMovingAveragePct.sma20).toBeGreaterThan(0);
    expect(summary?.vsMovingAveragePct.sma200).toBeNull();
    expect(summary?.rsi14).toBe(100);
  });

  it("returns nothing rather than guessing from too little or broken data", () => {
    expect(summarizePriceHistory([])).toBeNull();
    expect(summarizePriceHistory(bars([1, 2, 3]))).toBeNull();
    expect(summarizePriceHistory(bars([Number.NaN, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("valuation", () => {
  it("prices the company from the share count and the latest fiscal year", () => {
    const valuation = computeValuation(fundamentals(), 100);
    expect(valuation).toMatchObject({ marketCapUsd: 100_000_000, priceToSales: 2, priceToEarnings: 20 });
  });

  it("reports a loss instead of a negative P/E, and nothing without a share count", () => {
    const loss = fundamentals();
    loss.annual!.netIncome!.value = -1;
    expect(computeValuation(loss, 100)).toMatchObject({ priceToEarnings: null, annualNetIncomeNegative: true });
    expect(computeValuation(fundamentals({ sharesOutstanding: null }), 100)).toBeNull();
    expect(computeValuation(fundamentals(), 0)).toBeNull();
  });
});

describe("trading session", () => {
  it("separates regular hours from after-hours and weekend trades", () => {
    expect(tradingSession("2026-11-10T15:00:00Z")).toBe("regular");
    expect(tradingSession("2026-11-10T21:31:25Z")).toBe("extended");
    expect(tradingSession("2026-11-10T14:00:00Z")).toBe("extended");
    expect(tradingSession("2026-11-14T15:00:00Z")).toBe("extended");
    expect(tradingSession("not a date")).toBe("unknown");
  });
});

describe("minutes since the open", () => {
  it("counts from 9:30 in New York, in winter and summer time", () => {
    expect(minutesSinceOpen(Date.parse("2026-11-12T14:30:00Z"))).toBe(0);
    expect(minutesSinceOpen(Date.parse("2026-11-12T14:59:00Z"))).toBe(29);
    expect(minutesSinceOpen(Date.parse("2026-11-12T14:00:00Z"))).toBe(-30);
    expect(minutesSinceOpen(Date.parse("2026-07-15T13:45:00Z"))).toBe(15);
  });
});

describe("headlines for a prompt", () => {
  it("puts each headline on one short line with its time, stocks and source", () => {
    const text = formatHeadlines([
      {
        id: "1",
        headline: "Chief executive\nresigns   after board review",
        source: "wire",
        created_at: "2026-11-12T14:21:07Z",
        symbols: ["TEST"],
      },
      {
        id: "2",
        headline: "x".repeat(500),
        source: "",
        created_at: "2026-11-12T13:00:00Z",
        symbols: ["TEST", "OTHER"],
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("- 2026-11-12 14:21 UTC [TEST] Chief executive resigns after board review (wire)");
    expect(lines[1]).toBe(`- 2026-11-12 13:00 UTC [TEST, OTHER] ${"x".repeat(200)}`);
    expect(lines).toHaveLength(2);
  });

  it("says so when there is no news", () => {
    expect(formatHeadlines([])).toBe("No headlines found for the last two days.");
  });
});
