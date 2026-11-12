import type { AgentConfig } from "../schemas/agent-config";

/** Why the agent wants to sell: a rule on price, a rule on time, or the analyst model's judgement. */
export type ExitKind = "take_profit" | "stop_loss" | "stale" | "analyst";

/** The analyst model's decision on a position that has fallen past the stop loss. */
export interface StopLossReview {
  decision: "SELL" | "HOLD";
  reasoning: string;
  /** The position's gain or loss, in percent, when it was reviewed. */
  plPct: number;
  timestamp: number;
}

/** A review is repeated after this long, so later news is taken into account. */
export const REVIEW_MAX_AGE_MS = 2 * 60 * 60_000;
/** A review is repeated once the loss is this many percentage points deeper than when it was made. */
export const REVIEW_DEEPER_PCT = 3;

type ExitConfig = Pick<AgentConfig, "stop_loss_pct" | "hard_stop_loss_pct" | "open_sell_delay_minutes">;

/**
 * What stands between a wish to sell and the order.
 *
 * - At the hard stop the position is sold at once, whatever anyone thinks.
 * - Opening prices swing widely, so any other sale waits out the first minutes of the session.
 * - Between the stop loss and the hard stop, the analyst model reviews the position with the news
 *   before it is sold. A stale position is the exception: its time is up either way.
 */
export function nextExitStep(input: {
  plPct: number;
  kind: ExitKind;
  minutesSinceOpen: number;
  config: ExitConfig;
}): "sell" | "wait_for_open" | "review" {
  const { plPct, kind, minutesSinceOpen, config } = input;
  if (plPct <= -config.hard_stop_loss_pct) return "sell";
  if (minutesSinceOpen >= 0 && minutesSinceOpen < config.open_sell_delay_minutes) return "wait_for_open";
  if (plPct <= -config.stop_loss_pct && kind !== "stale") return "review";
  return "sell";
}

/** Whether an earlier review still stands for a position now at `plPct`. */
export function reviewIsCurrent(
  review: StopLossReview | undefined,
  plPct: number,
  now = Date.now()
): review is StopLossReview {
  if (!review) return false;
  return now - review.timestamp < REVIEW_MAX_AGE_MS && review.plPct - plPct < REVIEW_DEEPER_PCT;
}

/** A position's gain or loss as a percentage of what was paid for it. */
export function positionPlPct(position: { unrealized_pl: number; market_value: number }): number {
  const cost = position.market_value - position.unrealized_pl;
  return cost > 0 ? (position.unrealized_pl / cost) * 100 : 0;
}
