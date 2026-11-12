/**
 * Exit rules — decide which positions to sell.
 *
 * This function handles: TP, staleness, SL, and options exits.
 * Core decides whether a candidate is sold now: see core/exit-policy.ts.
 */

import type { Account, Position } from "../../../core/types";
import type { SellCandidate, StrategyContext } from "../../types";
import { analyzeStaleness } from "./staleness";

/**
 * Evaluate all positions and return sell candidates.
 * Core handles the actual order execution.
 */
export function selectExits(ctx: StrategyContext, positions: Position[], _account: Account): SellCandidate[] {
  const exits: SellCandidate[] = [];

  for (const pos of positions) {
    // Options are handled separately
    if (pos.asset_class === "us_option") {
      const optionExit = checkOptionsExit(pos, ctx);
      if (optionExit) exits.push(optionExit);
      continue;
    }

    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

    // Take profit
    if (plPct >= ctx.config.take_profit_pct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Take profit at +${plPct.toFixed(1)}%`,
        kind: "take_profit",
      });
      continue;
    }

    // Staleness is judged before the stop loss: a stop-loss exit can be held back on review,
    // and a position that has also run out of time should leave either way.
    if (ctx.config.stale_position_enabled) {
      // Get current social volume from strategy state
      const socialSnapshot = ctx.state.get<Record<string, { volume: number }>>("socialSnapshotCache") ?? {};
      const currentSocialVolume = socialSnapshot[pos.symbol]?.volume ?? 0;
      const entry = ctx.positionEntries[pos.symbol];

      const stalenessResult = analyzeStaleness(pos.symbol, pos.current_price, currentSocialVolume, entry, ctx.config);

      // Store for status dashboard visibility
      const stalenessState = ctx.state.get<Record<string, unknown>>("stalenessAnalysis") ?? {};
      stalenessState[pos.symbol] = stalenessResult;
      ctx.state.set("stalenessAnalysis", stalenessState);

      if (stalenessResult.isStale) {
        exits.push({
          symbol: pos.symbol,
          reason: `STALE: ${stalenessResult.reason}`,
          kind: "stale",
        });
        continue;
      }
    }

    // Stop loss
    if (plPct <= -ctx.config.stop_loss_pct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Stop loss at ${plPct.toFixed(1)}%`,
        kind: "stop_loss",
      });
    }
  }

  return exits;
}

function checkOptionsExit(pos: Position, ctx: StrategyContext): SellCandidate | null {
  if (!ctx.config.options_enabled) return null;

  const entryPrice = pos.avg_entry_price || pos.current_price;
  const plPct = entryPrice > 0 ? ((pos.current_price - entryPrice) / entryPrice) * 100 : 0;

  if (plPct <= -ctx.config.options_stop_loss_pct) {
    return {
      symbol: pos.symbol,
      reason: `Options stop loss at ${plPct.toFixed(1)}%`,
    };
  }

  if (plPct >= ctx.config.options_take_profit_pct) {
    return {
      symbol: pos.symbol,
      reason: `Options take profit at +${plPct.toFixed(1)}%`,
    };
  }

  return null;
}
