import { describe, expect, it } from "vitest";
import { getSleeve } from "./sleeve";

describe("trading sleeve", () => {
  it("starts at the configured bankroll when nothing is open", () => {
    expect(getSleeve([], 100, 0)).toMatchObject({ equity: 100, cash: 100, unrealizedPnl: 0 });
  });

  it("keeps free cash flat while an open position is ahead", () => {
    const open = getSleeve([{ market_value: 12, cost_basis: 8, unrealized_pl: 4 }], 100, 0);
    expect(open.cash).toBe(92);
    expect(open.equity).toBe(104);

    const closed = getSleeve([], 100, 4);
    expect(closed.cash).toBe(104);
    expect(closed.equity).toBe(104);
  });

  it("ignores broker cash above the sleeve and blocks an overdrawn book", () => {
    const sleeve = getSleeve([{ market_value: 5000, cost_basis: 5000, unrealized_pl: 0 }], 100, 0);
    expect(sleeve.cash).toBe(-4900);
    expect(sleeve.equity).toBe(100);
  });

  it("infers cost from market value when the broker omits cost basis", () => {
    expect(getSleeve([{ market_value: 8, unrealized_pl: 0 }], 100, 0).cash).toBe(92);
  });
});
