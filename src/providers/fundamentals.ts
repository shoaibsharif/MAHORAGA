import type { Env } from "../env.d";
import { getStoredFundamentals, storeFundamentals } from "../storage/d1/queries/screening";

interface Fact {
  val: number;
  start?: string;
  end: string;
  filed: string;
  form: string;
}

export interface FinancialMetric {
  concept: string;
  value: number;
  unit: "USD";
  start: string | null;
  end: string;
  filed: string;
}

/** Bumped whenever the extracted fields change, so stored copies in the old shape are fetched again. */
const CONTEXT_VERSION = 3;

export interface FundamentalContext {
  version?: number;
  symbol: string;
  company: string | null;
  checkedAt: string;
  sourceUrl: string | null;
  metrics: Record<string, FinancialMetric>;
  /** Full fiscal-year figures from the latest annual report, for valuation multiples. */
  annual?: Record<string, FinancialMetric>;
  sharesOutstanding?: {
    value: number;
    end: string;
    filed: string;
    /**
     * Where the count came from. `average` is the quarter's weighted-average share count, an
     * approximation used when a company reports its exact count only per share class.
     */
    source?: "cover" | "balance_sheet" | "average";
  } | null;
  /** Recent quarters and fiscal years, oldest first, so growth and margins can be judged. */
  trend?: FinancialTrend | null;
  filings: Array<{ form: string; filed: string; url: string }>;
  limitations: string[];
}

export interface TrendPeriod {
  end: string;
  revenue: number | null;
  netIncome: number | null;
  /** Net income as a percent of revenue. */
  netMarginPct: number | null;
  /** Revenue change from the same period a year earlier. */
  revenueYoYPct: number | null;
  /** Fourth quarters are not filed separately; they are the fiscal year minus the first three quarters. */
  derived?: true;
}

export interface FinancialTrend {
  quarters: TrendPeriod[];
  fiscalYears: Array<TrendPeriod & { operatingCashFlow: number | null }>;
}

const ANNUAL_FORMS = ["10-K", "10-K/A"];
const DAY_MS = 86_400_000;

/** A full fiscal year: an annual report covering roughly twelve months. */
function isFiscalYear(fact: Fact): boolean {
  if (!ANNUAL_FORMS.includes(fact.form) || !fact.start) return false;
  const days = (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
  return days >= 340 && days <= 380;
}

export function extractMetrics(
  facts: Record<string, { units?: { USD?: Fact[] } }>,
  annualOnly = false
): FundamentalContext["metrics"] {
  const concepts: Record<string, string[]> = {
    revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
    netIncome: ["NetIncomeLoss", "ProfitLoss"],
    operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
    cash: ["CashAndCashEquivalentsAtCarryingValue"],
    totalAssets: ["Assets"],
    totalLiabilities: ["Liabilities"],
  };
  const metrics: FundamentalContext["metrics"] = {};
  for (const [name, tags] of Object.entries(concepts)) {
    const candidates = tags
      .flatMap((concept) => (facts[concept]?.units?.USD ?? []).map((fact) => ({ concept, ...fact })))
      .filter(
        (fact) =>
          Number.isFinite(fact.val) &&
          ["10-K", "10-Q", "10-K/A", "10-Q/A"].includes(fact.form) &&
          Number.isFinite(Date.parse(fact.end)) &&
          Date.parse(fact.end) <= Date.now() &&
          Number.isFinite(Date.parse(fact.filed)) &&
          Date.parse(fact.filed) <= Date.now() &&
          (!fact.start || Date.parse(fact.start) <= Date.parse(fact.end)) &&
          (!annualOnly || isFiscalYear(fact))
      )
      .sort(
        (a, b) =>
          b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed) || (b.start ?? "").localeCompare(a.start ?? "")
      );
    const latest = candidates[0];
    if (latest)
      metrics[name] = {
        concept: latest.concept,
        value: latest.val,
        unit: "USD",
        start: latest.start ?? null,
        end: latest.end,
        filed: latest.filed,
      };
  }
  return metrics;
}

type FactSet = Record<string, { units?: { USD?: Fact[] } }>;
const TREND_TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
};
const pct = (part: number | null, whole: number | null): number | null =>
  part == null || !whole ? null : Number(((part / whole) * 100).toFixed(1));

/** Values for periods of the given length, keyed by end date. A restated figure replaces the original. */
function periodValues(facts: FactSet, tags: string[], minDays: number, maxDays: number): Map<string, Fact> {
  const byEnd = new Map<string, Fact>();
  // Earlier tags are the current standard, so they win when two tags report the same period.
  for (const tag of [...tags].reverse()) {
    const candidates = (facts[tag]?.units?.USD ?? [])
      .filter((fact) => {
        if (!Number.isFinite(fact.val) || !fact.start || Date.parse(fact.end) > Date.now()) return false;
        const days = (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
        return days >= minDays && days <= maxDays;
      })
      .sort((a, b) => a.filed.localeCompare(b.filed));
    for (const fact of candidates) byEnd.set(fact.end, fact);
  }
  return byEnd;
}

/** Up to eight recent quarters and four fiscal years of revenue, earnings and operating cash flow. */
export function extractTrend(facts: FactSet): FinancialTrend | null {
  const series = (tags: string[], annual: boolean) =>
    annual ? periodValues(facts, tags, 340, 380) : periodValues(facts, tags, 80, 100);
  const quarterly = { revenue: series(TREND_TAGS.revenue, false), netIncome: series(TREND_TAGS.netIncome, false) };
  const yearly = {
    revenue: series(TREND_TAGS.revenue, true),
    netIncome: series(TREND_TAGS.netIncome, true),
    operatingCashFlow: series(TREND_TAGS.operatingCashFlow, true),
  };

  const derived = new Set<string>();
  for (const metric of ["revenue", "netIncome"] as const) {
    for (const [end, year] of yearly[metric]) {
      if (quarterly[metric].has(end) || !year.start) continue;
      const within = [...quarterly[metric].values()].filter((q) => q.end > (year.start ?? "") && q.end < end);
      if (within.length !== 3) continue;
      quarterly[metric].set(end, { ...year, val: year.val - within.reduce((sum, q) => sum + q.val, 0) });
      derived.add(end);
    }
  }

  const yearAgo = (values: Map<string, Fact>, end: string): number | null => {
    const target = Date.parse(end) - 365 * DAY_MS;
    for (const [other, fact] of values) if (Math.abs(Date.parse(other) - target) <= 20 * DAY_MS) return fact.val;
    return null;
  };
  const period = (values: { revenue: Map<string, Fact>; netIncome: Map<string, Fact> }, end: string): TrendPeriod => {
    const revenue = values.revenue.get(end)?.val ?? null;
    const netIncome = values.netIncome.get(end)?.val ?? null;
    const prior = yearAgo(values.revenue, end);
    return {
      end,
      revenue,
      netIncome,
      netMarginPct: revenue && revenue > 0 ? pct(netIncome, revenue) : null,
      revenueYoYPct: revenue != null && prior && prior > 0 ? pct(revenue - prior, prior) : null,
      ...(derived.has(end) && values === quarterly ? { derived: true as const } : {}),
    };
  };
  const ends = (...maps: Array<Map<string, Fact>>) => [...new Set(maps.flatMap((map) => [...map.keys()]))].sort();
  const quarters = ends(quarterly.revenue, quarterly.netIncome)
    .slice(-8)
    .map((end) => period(quarterly, end));
  const fiscalYears = ends(yearly.revenue, yearly.netIncome)
    .slice(-4)
    .map((end) => ({ ...period(yearly, end), operatingCashFlow: yearly.operatingCashFlow.get(end)?.val ?? null }));
  return quarters.length || fiscalYears.length ? { quarters, fiscalYears } : null;
}

/** The most recent cover-page share count; several classes reported on one date are summed. */
export function latestShareCount(facts: Fact[] = []): FundamentalContext["sharesOutstanding"] {
  const valid = facts.filter(
    (fact) =>
      Number.isFinite(fact.val) &&
      fact.val > 0 &&
      Number.isFinite(Date.parse(fact.end)) &&
      Date.parse(fact.end) <= Date.now()
  );
  const end = valid
    .map((fact) => fact.end)
    .sort()
    .at(-1);
  if (!end) return null;
  const sameDate = valid.filter((fact) => fact.end === end);
  const latestFiling =
    sameDate
      .map((fact) => fact.filed)
      .sort()
      .at(-1) ?? end;
  const fromLatestFiling = sameDate.filter((fact) => fact.filed === latestFiling);
  return { value: fromLatestFiling.reduce((sum, fact) => sum + fact.val, 0), end, filed: latestFiling };
}

type ShareFacts = Record<string, { units?: { shares?: Fact[] } }>;
/** A real listed company has far more shares than this; shells and placeholder filings report 1. */
const MIN_PLAUSIBLE_SHARES = 100_000;
const MAX_SHARE_COUNT_AGE_MS = 400 * DAY_MS;

/**
 * The best available share count. SEC's data omits figures that are broken down by share
 * class, so a company with several classes has no cover-page or balance-sheet total; its
 * weighted-average count for the latest quarter is then the closest published figure.
 */
export function resolveShareCount(
  dei: ShareFacts = {},
  gaap: ShareFacts = {}
): FundamentalContext["sharesOutstanding"] {
  const usable = (count: FundamentalContext["sharesOutstanding"]) =>
    !!count && count.value >= MIN_PLAUSIBLE_SHARES && Date.now() - Date.parse(count.end) <= MAX_SHARE_COUNT_AGE_MS;

  const cover = latestShareCount(dei.EntityCommonStockSharesOutstanding?.units?.shares);
  if (cover && usable(cover)) return { ...cover, source: "cover" };

  const balanceSheet = latestShareCount(gaap.CommonStockSharesOutstanding?.units?.shares);
  if (balanceSheet && usable(balanceSheet)) return { ...balanceSheet, source: "balance_sheet" };

  // Prefer a single quarter: year-to-date averages lag the current count further.
  const averages = (gaap.WeightedAverageNumberOfSharesOutstandingBasic?.units?.shares ?? []).filter(
    (fact) => Number.isFinite(fact.val) && !!fact.start && Date.parse(fact.end) <= Date.now()
  );
  const quarterly = averages.filter((fact) => {
    const days = (Date.parse(fact.end) - Date.parse(fact.start ?? fact.end)) / DAY_MS;
    return days >= 80 && days <= 100;
  });
  const latest = (quarterly.length ? quarterly : averages)
    .sort((a, b) => a.end.localeCompare(b.end) || a.filed.localeCompare(b.filed))
    .at(-1);
  const average = latest
    ? { value: latest.val, end: latest.end, filed: latest.filed, source: "average" as const }
    : null;
  return average && usable(average) ? average : null;
}

export async function getFundamentalContext(
  env: Pick<Env, "CACHE" | "DB" | "SEC_USER_AGENT">,
  symbol: string
): Promise<FundamentalContext> {
  const result: FundamentalContext = {
    version: CONTEXT_VERSION,
    symbol,
    company: null,
    checkedAt: new Date().toISOString(),
    sourceUrl: null,
    metrics: {},
    filings: [],
    limitations: [],
  };
  const headers = {
    "User-Agent": env.SEC_USER_AGENT || "MAHORAGA research (https://github.com/ygwyg/MAHORAGA)",
    Accept: "application/json",
  };
  async function json(url: string): Promise<unknown> {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000), redirect: "manual" });
    if (!response.ok) {
      // SEC's error page title says whether it rejected the client identity or the request rate.
      const title = (await response.text().catch(() => "")).match(/<title>([^<]{1,120})/i)?.[1]?.trim();
      throw new Error(`SEC returned HTTP ${response.status}${title ? ` (${title})` : ""}`);
    }
    return response.json();
  }
  try {
    const cached = await getStoredFundamentals(env.DB, symbol).catch(() => null);
    // SEC figures change when a company files, so a day-old copy is current enough.
    const current = cached?.symbol === symbol && cached.version === CONTEXT_VERSION;
    if (cached && current && Date.now() - Date.parse(cached.checkedAt) < 86_400_000) return cached;
    let tickers = await env.CACHE.get<Record<string, { cik_str: number; ticker: string; title: string }>>(
      "fundamentals:sec:tickers",
      "json"
    ).catch(() => null);
    if (!tickers) {
      tickers = (await json("https://www.sec.gov/files/company_tickers.json")) as NonNullable<typeof tickers>;
      await env.CACHE.put("fundamentals:sec:tickers", JSON.stringify(tickers), { expirationTtl: 86_400 }).catch(
        () => {}
      );
    }
    const company = Object.values(tickers).find((entry) => entry.ticker === symbol);
    if (!company || !Number.isInteger(company.cik_str) || company.cik_str <= 0)
      throw new Error("No matching SEC issuer found");
    result.company = company.title;
    const cik = String(company.cik_str).padStart(10, "0");
    result.sourceUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const [facts, submissions] = await Promise.allSettled([
      json(result.sourceUrl),
      json(`https://data.sec.gov/submissions/CIK${cik}.json`),
    ]);
    if (facts.status === "fulfilled") {
      const data = facts.value as {
        cik?: number | string;
        facts?: {
          "us-gaap"?: Parameters<typeof extractMetrics>[0] & ShareFacts;
          dei?: ShareFacts;
        };
      };
      // SEC sends the CIK as a number for some issuers and a zero-padded string for others.
      if (Number(data.cik) !== company.cik_str) throw new Error("SEC financial facts do not match the issuer");
      result.metrics = extractMetrics(data.facts?.["us-gaap"] ?? {});
      result.annual = extractMetrics(data.facts?.["us-gaap"] ?? {}, true);
      result.trend = extractTrend(data.facts?.["us-gaap"] ?? {});
      result.sharesOutstanding = resolveShareCount(data.facts?.dei, data.facts?.["us-gaap"]);
    } else result.limitations.push("SEC financial facts unavailable");
    if (submissions.status === "fulfilled") {
      const data = submissions.value as {
        tickers?: string[];
        filings?: {
          recent?: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] };
        };
      };
      if (!data.tickers?.includes(symbol)) throw new Error("SEC filings do not match the symbol");
      const recent = data.filings?.recent;
      for (let i = 0; recent && i < recent.form.length && result.filings.length < 5; i++) {
        const form = recent.form[i];
        const accession = recent.accessionNumber[i];
        const document = recent.primaryDocument[i];
        const filed = recent.filingDate[i];
        if (
          form &&
          ["10-K", "10-Q", "8-K", "10-K/A", "10-Q/A"].includes(form) &&
          accession &&
          /^[\d-]+$/.test(accession) &&
          document &&
          filed
        ) {
          result.filings.push({
            form,
            filed,
            url: `https://www.sec.gov/Archives/edgar/data/${company.cik_str}/${accession.replaceAll("-", "")}/${encodeURIComponent(document)}`,
          });
        }
      }
    } else result.limitations.push("Recent SEC filings unavailable");
    result.limitations.push(
      "Figures retain their reported periods; quarterly, year-to-date and annual figures must not be compared as equivalent. Filing links are metadata, not reviewed filing contents."
    );
    if (!Object.keys(result.metrics).length) result.limitations.push("No supported USD US-GAAP financial facts found");
    await storeFundamentals(env.DB, result).catch(() => {});
  } catch (error) {
    result.limitations.push(error instanceof Error ? error.message : "Financial data unavailable");
  }
  return result;
}
