import type { Env } from "../env.d";

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

export interface FundamentalContext {
  symbol: string;
  company: string | null;
  checkedAt: string;
  sourceUrl: string | null;
  metrics: Record<string, FinancialMetric>;
  filings: Array<{ form: string; filed: string; url: string }>;
  limitations: string[];
}

export function extractMetrics(facts: Record<string, { units?: { USD?: Fact[] } }>): FundamentalContext["metrics"] {
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
          (!fact.start || Date.parse(fact.start) <= Date.parse(fact.end))
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

export async function getFundamentalContext(
  env: Pick<Env, "CACHE" | "SEC_USER_AGENT">,
  symbol: string
): Promise<FundamentalContext> {
  const result: FundamentalContext = {
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
    const key = `fundamentals:sec:v1:${symbol}`;
    const cached = await env.CACHE.get<FundamentalContext>(key, "json").catch(() => null);
    if (cached?.symbol === symbol && Date.now() - Date.parse(cached.checkedAt) < 3_600_000) return cached;
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
      const data = facts.value as { cik?: number; facts?: { "us-gaap"?: Parameters<typeof extractMetrics>[0] } };
      if (data.cik !== company.cik_str) throw new Error("SEC financial facts do not match the issuer");
      result.metrics = extractMetrics(data.facts?.["us-gaap"] ?? {});
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
    await env.CACHE.put(key, JSON.stringify(result), { expirationTtl: 3_600 }).catch(() => {});
  } catch (error) {
    result.limitations.push(error instanceof Error ? error.message : "Financial data unavailable");
  }
  return result;
}
