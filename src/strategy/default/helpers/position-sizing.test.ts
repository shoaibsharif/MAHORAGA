import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { getEntryNotional } from "./position-sizing";

const smallAccount = DEFAULT_CONFIG;

describe("entry sizing", () => {
  it("permits fractional entries for a $100 account instead of requiring $100 orders", () => {
    expect(getEntryNotional({ cash: 100 }, 0.8, smallAccount)).toBe(8);
    expect(getEntryNotional({ cash: 100 }, 0.8, { ...smallAccount, min_trade_notional: 100 })).toBe(0);
  });

  it("scales with the account instead of retaining a fixed $10 cap", () => {
    expect(getEntryNotional({ cash: 200 }, 1, smallAccount)).toBe(20);
    expect(getEntryNotional({ cash: 1000 }, 1, smallAccount)).toBe(100);
  });

  it("does not round a below-minimum entry up to the broker minimum", () => {
    expect(getEntryNotional({ cash: 9.99 }, 1, smallAccount)).toBe(0);
    expect(getEntryNotional({ cash: 10 }, 1, smallAccount)).toBe(1);
  });

  it("honors an optional dollar cap and rounds down to cents", () => {
    expect(getEntryNotional({ cash: 100 }, 0.87654, { ...smallAccount, max_position_value: 8 })).toBe(8);
    expect(getEntryNotional({ cash: 100 }, 0.87654, smallAccount)).toBe(8.76);
  });
});
