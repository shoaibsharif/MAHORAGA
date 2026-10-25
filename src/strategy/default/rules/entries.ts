/**
 * Entry rules — decide which signals to buy.
 *
 * Core handles PolicyEngine checks and actual order execution.
 * Core ALWAYS enforces stop-loss from config as a safety floor.
 */

import type { Account, Position, ResearchResult } from "../../../core/types";
import type { BuyCandidate, StrategyContext } from "../../types";
import { getEntryNotional } from "../helpers/position-sizing";

/**
 * Select entry candidates from LLM-researched signals.
 *
 * Filters for BUY verdicts above min confidence threshold,
 * skips already-held symbols, and ranks by confidence.
 */
export function selectEntries(
  ctx: StrategyContext,
  research: ResearchResult[],
  positions: Position[],
  account: Account
): BuyCandidate[] {
  const heldSymbols = new Set(positions.map((p) => p.symbol));
  const candidates: BuyCandidate[] = [];

  if (positions.length >= ctx.config.max_positions) return [];

  const buyResearch = research
    .filter((r) => r.verdict === "BUY" && r.confidence >= ctx.config.min_analyst_confidence)
    .filter((r) => !heldSymbols.has(r.symbol))
    .sort((a, b) => b.confidence - a.confidence);

  for (const r of buyResearch.slice(0, 3)) {
    if (positions.length + candidates.length >= ctx.config.max_positions) break;

    const notional = getEntryNotional(account, r.confidence, ctx.config);
    if (notional === 0) continue;

    const shouldUseOptions =
      ctx.config.options_enabled &&
      r.confidence >= ctx.config.options_min_confidence &&
      r.entry_quality === "excellent";

    candidates.push({
      symbol: r.symbol,
      confidence: r.confidence,
      reason: r.reasoning,
      notional,
      useOptions: shouldUseOptions,
    });
  }

  return candidates;
}
