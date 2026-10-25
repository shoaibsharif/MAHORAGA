import { getSleeve } from "../../../core/sleeve";
import type { PolicyConfig } from "../../../policy/config";
import type { Position } from "../../../providers/types";
import type { AgentConfig } from "../../../schemas/agent-config";

export interface EntryNotionalInput {
  cash: number;
  confidence: number;
  positionSizePctOfCash: number;
  maxPositionValue: number | null;
  minTradeNotional: number;
  maxPositionPctOfEquity: number;
  maxNotionalPerTrade: number | null;
  equity: number;
}

/**
 * Dollar size for one new entry.
 * Uses the requested percent of free cash, then clamps to the same ceilings
 * the policy engine enforces: percent of sleeve equity, optional dollar caps,
 * and the cash that is actually free.
 */
export function getEntryNotional(input: EntryNotionalInput): number {
  const {
    cash,
    confidence,
    positionSizePctOfCash,
    maxPositionValue,
    minTradeNotional,
    maxPositionPctOfEquity,
    maxNotionalPerTrade,
    equity,
  } = input;
  if (
    !Number.isFinite(cash) ||
    cash <= 0 ||
    !Number.isFinite(confidence) ||
    confidence <= 0 ||
    confidence > 1 ||
    !Number.isFinite(positionSizePctOfCash) ||
    positionSizePctOfCash <= 0 ||
    !Number.isFinite(equity) ||
    equity <= 0 ||
    !Number.isFinite(maxPositionPctOfEquity) ||
    maxPositionPctOfEquity <= 0
  ) {
    return 0;
  }

  let budget = cash * (positionSizePctOfCash / 100) * confidence;
  budget = Math.min(budget, cash, equity * maxPositionPctOfEquity);
  if (maxPositionValue != null && Number.isFinite(maxPositionValue)) budget = Math.min(budget, maxPositionValue);
  if (maxNotionalPerTrade != null && Number.isFinite(maxNotionalPerTrade)) {
    budget = Math.min(budget, maxNotionalPerTrade);
  }
  const notional = Math.floor(budget * 100) / 100;
  return notional >= minTradeNotional ? notional : 0;
}

export function entryNotionalFor(args: {
  accountCash: number;
  positions: readonly Pick<Position, "market_value" | "unrealized_pl" | "cost_basis">[];
  confidence: number;
  config: Pick<
    AgentConfig,
    "starting_equity" | "position_size_pct_of_cash" | "max_position_value" | "min_trade_notional"
  >;
  realizedPnl: number;
  policy: Pick<PolicyConfig, "max_position_pct_equity" | "max_notional_per_trade">;
  maxPositionValue?: number | null;
}): number {
  const sleeve = getSleeve(args.positions, args.config.starting_equity, args.realizedPnl);
  const accountCash = Number.isFinite(args.accountCash) ? Math.max(0, args.accountCash) : 0;
  const cash = Math.min(accountCash, Math.max(0, sleeve.cash));
  return getEntryNotional({
    cash,
    confidence: args.confidence,
    positionSizePctOfCash: args.config.position_size_pct_of_cash,
    maxPositionValue: args.maxPositionValue === undefined ? args.config.max_position_value : args.maxPositionValue,
    minTradeNotional: args.config.min_trade_notional,
    maxPositionPctOfEquity: args.policy.max_position_pct_equity,
    maxNotionalPerTrade: args.policy.max_notional_per_trade,
    equity: sleeve.equity,
  });
}
