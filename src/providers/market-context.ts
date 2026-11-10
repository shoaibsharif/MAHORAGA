import type { FundamentalContext } from "./fundamentals";
import { computeTechnicals } from "./technicals";
import type { Bar } from "./types";

export interface PriceHistory {
  asOf: string;
  tradingDays: number;
  lastClose: number;
  /** Percent change in close over 5, 20 and 60 trading days. */
  returnPct: { d5: number | null; d20: number | null; d60: number | null };
  /** Percent of the last close below the period high and above the period low. */
  belowHighPct: number;
  aboveLowPct: number;
  /** Percent of the last close above (positive) or below (negative) each moving average. */
  vsMovingAveragePct: { sma20: number | null; sma50: number | null; sma200: number | null };
  rsi14: number | null;
  macdHistogram: number | null;
  /** Average true range as a percent of the last close: typical daily move. */
  atrPct: number | null;
  /** Latest day's volume divided by its 20-day average. */
  relativeVolume: number | null;
}

export interface Valuation {
  marketCapUsd: number;
  priceToSales: number | null;
  priceToEarnings: number | null;
  annualNetIncomeNegative: boolean;
  basis: string;
}

const round = (value: number | null | undefined, digits = 2): number | null =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

const pct = (from: number | null | undefined, to: number): number | null =>
  from == null || !Number.isFinite(from) || from === 0 ? null : round(((to - from) / from) * 100);

/** Condenses daily bars into the figures the research prompt needs to judge timing. */
export function summarizePriceHistory(bars: Bar[]): PriceHistory | null {
  const valid = bars.filter((bar) => [bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite) && bar.c > 0);
  const last = valid.at(-1);
  if (!last || valid.length < 5) return null;
  const closes = valid.map((bar) => bar.c);
  const ago = (days: number) => (closes.length > days ? closes[closes.length - 1 - days] : null);
  const technicals = computeTechnicals("", valid);
  const high = Math.max(...valid.map((bar) => bar.h));
  const low = Math.min(...valid.map((bar) => bar.l));
  return {
    asOf: last.t,
    tradingDays: valid.length,
    lastClose: last.c,
    returnPct: { d5: pct(ago(5), last.c), d20: pct(ago(20), last.c), d60: pct(ago(60), last.c) },
    belowHighPct: round(((high - last.c) / high) * 100) ?? 0,
    aboveLowPct: round(((last.c - low) / low) * 100) ?? 0,
    vsMovingAveragePct: {
      sma20: pct(technicals.sma_20, last.c),
      sma50: pct(technicals.sma_50, last.c),
      sma200: pct(technicals.sma_200, last.c),
    },
    rsi14: round(technicals.rsi_14, 1),
    macdHistogram: round(technicals.macd?.histogram, 3),
    atrPct: technicals.atr_14 == null ? null : round((technicals.atr_14 / last.c) * 100),
    relativeVolume: round(technicals.relative_volume),
  };
}

/** Price multiples from the latest annual report and the reported share count. */
export function computeValuation(fundamentals: FundamentalContext, price: number): Valuation | null {
  const shares = fundamentals.sharesOutstanding;
  if (!shares || shares.value <= 0 || !(price > 0)) return null;
  const marketCap = shares.value * price;
  const revenue = fundamentals.annual?.revenue;
  const netIncome = fundamentals.annual?.netIncome;
  const period = revenue?.end ?? netIncome?.end;
  return {
    marketCapUsd: Math.round(marketCap),
    priceToSales: revenue && revenue.value > 0 ? round(marketCap / revenue.value) : null,
    priceToEarnings: netIncome && netIncome.value > 0 ? round(marketCap / netIncome.value) : null,
    annualNetIncomeNegative: !!netIncome && netIncome.value < 0,
    basis: `Shares outstanding ${shares.value} as of ${shares.end} times the current price; revenue and earnings from the fiscal year ending ${period ?? "unavailable"}. Companies with several share classes may be undercounted.`,
  };
}

/** Whether a trade happened in the regular New York session (9:30 to 16:00 on a weekday). */
export function tradingSession(timestamp: string): "regular" | "extended" | "unknown" {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "unknown";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(time))
      .map((part) => [part.type, part.value])
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "extended";
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 570 && minutes < 960 ? "regular" : "extended";
}
