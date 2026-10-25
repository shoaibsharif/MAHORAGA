import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { entryNotionalFor, getEntryNotional } from "./position-sizing";

const risk = {
  maxPositionPctOfEquity: 0.1,
  maxNotionalPerTrade: null as number | null,
};

function size(cash: number, confidence: number, overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  return getEntryNotional({
    cash,
    confidence,
    positionSizePctOfCash: config.position_size_pct_of_cash,
    maxPositionValue: config.max_position_value,
    minTradeNotional: config.min_trade_notional,
    maxPositionPctOfEquity: risk.maxPositionPctOfEquity,
    maxNotionalPerTrade: risk.maxNotionalPerTrade,
    equity: cash,
  });
}

describe("entry sizing", () => {
  it("permits fractional entries for a $100 sleeve", () => {
    expect(size(100, 0.8)).toBe(8);
    expect(size(100, 0.8, { min_trade_notional: 100 })).toBe(0);
  });

  it("scales with sleeve cash", () => {
    expect(size(200, 1)).toBe(20);
    expect(size(1000, 1)).toBe(100);
  });

  it("does not round a below-minimum entry up to the broker minimum", () => {
    expect(size(9.99, 1)).toBe(0);
    expect(size(10, 1)).toBe(1);
  });

  it("honors an optional dollar cap and rounds down to cents", () => {
    expect(size(100, 0.87654, { max_position_value: 8 })).toBe(8);
    expect(size(100, 0.87654)).toBe(8.76);
  });

  it("clamps a larger position percent to the policy ceiling", () => {
    expect(size(100, 1, { position_size_pct_of_cash: 25 })).toBe(10);
  });

  it("clamps to the fixed notional cap when one is set", () => {
    expect(
      getEntryNotional({
        cash: 100,
        confidence: 1,
        positionSizePctOfCash: 10,
        maxPositionValue: null,
        minTradeNotional: 1,
        maxPositionPctOfEquity: 0.1,
        maxNotionalPerTrade: 6,
        equity: 100,
      })
    ).toBe(6);
  });

  it("sizes from the sleeve when the broker account is much larger", () => {
    expect(
      entryNotionalFor({
        accountCash: 100_000,
        positions: [],
        confidence: 0.8,
        config: DEFAULT_CONFIG,
        realizedPnl: 0,
        policy: { max_position_pct_equity: 0.1, max_notional_per_trade: null },
      })
    ).toBe(8);
  });

  it("grows the next entry after a winning close", () => {
    expect(
      entryNotionalFor({
        accountCash: 100_000,
        positions: [],
        confidence: 1,
        config: DEFAULT_CONFIG,
        realizedPnl: 100,
        policy: { max_position_pct_equity: 0.1, max_notional_per_trade: null },
      })
    ).toBe(20);
  });
});
