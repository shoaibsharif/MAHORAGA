import { describe, expect, it } from "vitest";
import type { Order } from "../providers/types";
import { boughtToday, newYorkDate } from "./settlement";

const order = (fields: Partial<Order>) => ({ side: "buy", filled_qty: "1", ...fields }) as Order;

describe("trading days are counted in New York", () => {
  it("uses the New York date, not the UTC date", () => {
    // 01:30 UTC on the 12th is still the evening of the 11th in New York.
    expect(newYorkDate("2026-11-12T01:30:00Z")).toBe("2026-11-11");
    expect(newYorkDate("2026-11-12T15:00:00Z")).toBe("2026-11-12");
  });

  it("treats a purchase late yesterday as settled for today's session", () => {
    const now = Date.parse("2026-11-12T14:35:00Z");
    expect(boughtToday([order({ filled_at: "2026-11-11T20:59:00Z" })], now)).toBe(false);
    expect(boughtToday([order({ filled_at: "2026-11-12T14:31:00Z" })], now)).toBe(true);
  });

  it("counts a part-filled purchase and ignores sales and unfilled orders", () => {
    const now = Date.parse("2026-11-12T18:00:00Z");
    const today = "2026-11-12T15:00:00Z";
    expect(boughtToday([order({ filled_at: null, submitted_at: today, filled_qty: "0.2" })], now)).toBe(true);
    expect(boughtToday([order({ filled_at: today, side: "sell" })], now)).toBe(false);
    expect(boughtToday([order({ filled_at: null, submitted_at: today, filled_qty: "0" })], now)).toBe(false);
    expect(boughtToday([], now)).toBe(false);
  });
});
