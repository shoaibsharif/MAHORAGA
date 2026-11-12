import { describe, expect, it, vi } from "vitest";
import type { Account, Position, PositionEntry } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import { selectExits } from "./exits";

function position(symbol: string, plPct: number): Position {
  return {
    symbol,
    asset_class: "us_equity",
    qty: 1,
    avg_entry_price: 100,
    current_price: 100 + plPct,
    market_value: 100 + plPct,
    unrealized_pl: plPct,
  } as Position;
}

function context(entries: Record<string, Partial<PositionEntry>> = {}): StrategyContext {
  return {
    config: DEFAULT_CONFIG,
    positionEntries: entries,
    state: { get: vi.fn(), set: vi.fn() },
  } as unknown as StrategyContext;
}

describe("exit candidates", () => {
  it("names the rule behind each exit so core can treat them differently", () => {
    const exits = selectExits(
      context(),
      [position("UP", 12), position("DOWN", -6), position("FLAT", 1)],
      {} as Account
    );
    expect(exits).toEqual([
      { symbol: "UP", reason: "Take profit at +12.0%", kind: "take_profit" },
      { symbol: "DOWN", reason: "Stop loss at -6.0%", kind: "stop_loss" },
    ]);
  });

  it("treats a losing position that has also run out of time as stale, not as a stop loss", () => {
    const fourDaysAgo = Date.now() - 4 * 86_400_000;
    const exits = selectExits(
      context({ OLD: { entry_time: fourDaysAgo, entry_price: 100, entry_social_volume: 0 } }),
      [position("OLD", -6)],
      {} as Account
    );
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ symbol: "OLD", kind: "stale" });
  });
});
