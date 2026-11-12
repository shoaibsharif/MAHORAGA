import { describe, expect, it } from "vitest";
import { nextExitStep, positionPlPct, REVIEW_MAX_AGE_MS, reviewIsCurrent, type StopLossReview } from "./exit-policy";

const config = { stop_loss_pct: 5, hard_stop_loss_pct: 15, open_sell_delay_minutes: 30 };
const midSession = 120;

describe("what stands between a wish to sell and the order", () => {
  it("reviews a loss between the stop loss and the hard stop instead of selling it", () => {
    expect(nextExitStep({ plPct: -5, kind: "stop_loss", minutesSinceOpen: midSession, config })).toBe("review");
    expect(nextExitStep({ plPct: -14.9, kind: "analyst", minutesSinceOpen: midSession, config })).toBe("review");
    expect(nextExitStep({ plPct: -4.9, kind: "analyst", minutesSinceOpen: midSession, config })).toBe("sell");
  });

  it("always sells at the hard stop, even in the opening minutes", () => {
    expect(nextExitStep({ plPct: -15, kind: "stop_loss", minutesSinceOpen: 0, config })).toBe("sell");
    expect(nextExitStep({ plPct: -40, kind: "analyst", minutesSinceOpen: midSession, config })).toBe("sell");
  });

  it("holds every other sale back until the opening minutes have passed", () => {
    expect(nextExitStep({ plPct: 12, kind: "take_profit", minutesSinceOpen: 0, config })).toBe("wait_for_open");
    expect(nextExitStep({ plPct: -8, kind: "stop_loss", minutesSinceOpen: 29, config })).toBe("wait_for_open");
    expect(nextExitStep({ plPct: 12, kind: "take_profit", minutesSinceOpen: 30, config })).toBe("sell");
    expect(
      nextExitStep({
        plPct: 12,
        kind: "take_profit",
        minutesSinceOpen: 0,
        config: { ...config, open_sell_delay_minutes: 0 },
      })
    ).toBe("sell");
  });

  it("sells a stale position without a review, because its time is up either way", () => {
    expect(nextExitStep({ plPct: -8, kind: "stale", minutesSinceOpen: midSession, config })).toBe("sell");
  });

  it("goes back to a plain stop loss when the two levels are the same", () => {
    const plain = { ...config, hard_stop_loss_pct: 5 };
    expect(nextExitStep({ plPct: -5, kind: "stop_loss", minutesSinceOpen: midSession, config: plain })).toBe("sell");
  });
});

describe("how long a review stands", () => {
  const now = Date.parse("2026-11-12T16:00:00Z");
  const review: StopLossReview = { decision: "HOLD", reasoning: "Test", plPct: -6, timestamp: now - 60_000 };

  it("stands while it is recent and the loss has not deepened much", () => {
    expect(reviewIsCurrent(review, -6, now)).toBe(true);
    expect(reviewIsCurrent(review, -8.9, now)).toBe(true);
    expect(reviewIsCurrent(review, -2, now)).toBe(true);
  });

  it("is repeated once the loss is three points deeper, or after two hours", () => {
    expect(reviewIsCurrent(review, -9, now)).toBe(false);
    expect(reviewIsCurrent(review, -6, review.timestamp + REVIEW_MAX_AGE_MS)).toBe(false);
    expect(reviewIsCurrent(undefined, -6, now)).toBe(false);
  });
});

describe("a position's gain or loss", () => {
  it("is measured against what was paid", () => {
    expect(positionPlPct({ unrealized_pl: -8, market_value: 92 })).toBeCloseTo(-8);
    expect(positionPlPct({ unrealized_pl: 10, market_value: 110 })).toBeCloseTo(10);
    expect(positionPlPct({ unrealized_pl: 0, market_value: 0 })).toBe(0);
  });
});
