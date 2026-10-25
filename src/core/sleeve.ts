export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface SleevePosition {
  market_value?: number | null;
  unrealized_pl?: number | null;
  cost_basis?: number | null;
}

export interface SleeveSnapshot {
  equity: number;
  cash: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Bankroll the agent is allowed to trade.
 * Equity compounds from the configured starting balance plus closed and open P&L.
 * Cash is what remains after the cost of current positions.
 */
export function getSleeve(
  positions: readonly SleevePosition[],
  startingEquity: number,
  realizedPnl: number
): SleeveSnapshot {
  const start = finite(startingEquity) ?? 0;
  const realized = finite(realizedPnl) ?? 0;
  let marketValue = 0;
  let unrealizedPnl = 0;
  let costBasis = 0;

  for (const position of positions) {
    const market = finite(position.market_value) ?? 0;
    const unrealized = finite(position.unrealized_pl) ?? 0;
    const explicitBasis = finite(position.cost_basis);
    const inferredBasis = market - unrealized;
    const basis =
      explicitBasis != null && !(explicitBasis === 0 && inferredBasis !== 0) ? explicitBasis : inferredBasis;
    marketValue += market;
    unrealizedPnl += unrealized;
    costBasis += basis;
  }

  return {
    equity: roundCents(start + realized + unrealizedPnl),
    cash: roundCents(start + realized - costBasis),
    marketValue: roundCents(marketValue),
    costBasis: roundCents(costBasis),
    unrealizedPnl: roundCents(unrealizedPnl),
    realizedPnl: roundCents(realized),
  };
}
