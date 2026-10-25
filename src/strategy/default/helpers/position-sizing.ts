import type { Account, AgentConfig } from "../../../core/types";

export function getEntryNotional(
  account: Pick<Account, "cash">,
  confidence: number,
  config: Pick<AgentConfig, "position_size_pct_of_cash" | "max_position_value" | "min_trade_notional">
): number {
  if (
    !Number.isFinite(account.cash) ||
    account.cash <= 0 ||
    !Number.isFinite(confidence) ||
    confidence <= 0 ||
    confidence > 1
  )
    return 0;
  const budget = account.cash * (Math.min(20, config.position_size_pct_of_cash) / 100) * confidence;
  const notional = Math.floor(Math.min(budget, config.max_position_value ?? budget) * 100) / 100;
  return notional >= config.min_trade_notional ? notional : 0;
}
