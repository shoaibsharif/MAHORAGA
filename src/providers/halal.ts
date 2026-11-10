import { z } from "zod";

export const HALAL_PROVIDER = "HalalScreener";
export const HALAL_METHODOLOGY = "AAOIFI Standard 21";
export const HALAL_REPORT_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const HALAL_CACHE_MS = 60 * 60 * 1000;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;
const ratio = z.number().finite().nonnegative().nullable().optional();
const BadgeSchema = z.object({
  symbol: z.string(),
  name: z.string().min(1),
  status: z.string(),
  screenedAt: z.string(),
  assetType: z.string(),
  debtRatio: ratio,
  cashRatio: ratio,
  revenueRatio: ratio,
});

export interface HalalReport {
  symbol: string;
  name: string | null;
  provider: string;
  methodology: string;
  status: "compliant" | "non_compliant" | "questionable" | "unknown" | "stale" | "unsupported";
  assetType: string | null;
  screenedAt: string | null;
  checkedAt: string;
  expiresAt: string;
  sourceUrl: string;
  reasons: string[];
  metrics: { debtRatio: number | null; cashRatio: number | null; prohibitedRevenueRatio: number | null };
  purificationRatio: number | null;
}

export interface HalalScreening {
  screen(symbol: string): Promise<HalalReport>;
}

export function unknownHalalReport(symbol: string, reason: string, now = Date.now()): HalalReport {
  return {
    symbol,
    name: null,
    provider: HALAL_PROVIDER,
    methodology: HALAL_METHODOLOGY,
    status: "unknown",
    assetType: null,
    screenedAt: null,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    sourceUrl: `https://halalscreener.app/en/stock/${encodeURIComponent(symbol)}`,
    reasons: [reason],
    metrics: { debtRatio: null, cashRatio: null, prohibitedRevenueRatio: null },
    purificationRatio: null,
  };
}

export function halalBlockReason(report: HalalReport | undefined, symbol: string, now = Date.now()): string | null {
  if (!report || report.symbol !== symbol.trim().toUpperCase()) return "No matching halal screening evidence";
  if (report.provider !== HALAL_PROVIDER || report.methodology !== HALAL_METHODOLOGY)
    return "Unrecognized screening authority";
  if (report.status !== "compliant") return report.reasons?.join("; ") || `Screening status: ${report.status}`;
  if (report.assetType !== "stock") return "Only individual company stocks are eligible";
  if (!report.metrics) return "Screening evidence has an invalid financial-data shape";
  if (
    (report.metrics.debtRatio ?? 0) > 0.3 ||
    (report.metrics.cashRatio ?? 0) > 0.3 ||
    (report.metrics.prohibitedRevenueRatio ?? 0) > 0.05
  )
    return "Published financial ratios conflict with the provider's compliant verdict";
  const screened = Date.parse(report.screenedAt ?? "");
  const checked = Date.parse(report.checkedAt);
  const expires = Date.parse(report.expiresAt);
  if (!Number.isFinite(screened) || !Number.isFinite(checked) || !Number.isFinite(expires))
    return "Undated screening evidence";
  if (screened > now + 300_000 || checked > now + 300_000) return "Screening evidence is dated in the future";
  if (now - screened >= HALAL_REPORT_MAX_AGE_MS || now - checked >= HALAL_CACHE_MS || expires <= now)
    return "Screening evidence has expired";
  return null;
}

export function currentHalalReport(report: HalalReport, now = Date.now()): HalalReport {
  const reason = halalBlockReason(report, report.symbol, now);
  return report.status === "compliant" && reason ? { ...report, status: "stale", reasons: [reason] } : report;
}

export class HalalScreeningService implements HalalScreening {
  private pending = new Map<string, Promise<HalalReport>>();

  constructor(
    private cache?: KVNamespace,
    private fetcher: typeof fetch = fetch
  ) {}

  async screen(input: string): Promise<HalalReport> {
    const symbol = input.trim().toUpperCase();
    if (!SYMBOL.test(symbol)) {
      return { ...unknownHalalReport(symbol, "Only individual stock symbols can be screened"), status: "unsupported" };
    }
    const existing = this.pending.get(symbol);
    if (existing) return existing;
    const request = this.load(symbol).finally(() => this.pending.delete(symbol));
    this.pending.set(symbol, request);
    return request;
  }

  private async load(symbol: string): Promise<HalalReport> {
    const key = `halal:halalscreener:aaoifi21:v1:${symbol}`;
    try {
      const cached = await this.cache?.get<HalalReport>(key, "json");
      if (cached?.symbol === symbol && cached.status === "stale" && Date.now() - Date.parse(cached.checkedAt) < 120_000)
        return cached;
      if (cached?.symbol === symbol && Array.isArray(cached.reasons) && Date.parse(cached.expiresAt) > Date.now()) {
        if (cached.status !== "compliant" || halalBlockReason(cached, symbol) === null) return cached;
      }
    } catch {
      // A cache failure must not substitute for a fresh provider assessment.
    }

    let report: HalalReport;
    try {
      // Workers' fetch throws "Illegal invocation" when called with a `this`, so call it unbound.
      const fetcher = this.fetcher;
      const response = await fetcher(
        `https://halalscreener.app/api/embed/badge?symbol=${encodeURIComponent(symbol)}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
          // Workers only accepts "follow" or "manual"; a redirect is then rejected by the ok check.
          redirect: "manual",
        }
      );
      if (!response.ok) throw new Error(`Screening provider returned HTTP ${response.status}`);
      const data = BadgeSchema.parse(await response.json());
      if (data.symbol !== symbol) throw new Error("Screening provider returned a different symbol");
      const now = Date.now();
      const screened = Date.parse(data.screenedAt);
      if (!Number.isFinite(screened) || screened > now + 300_000)
        throw new Error("Screening provider returned an invalid assessment date");
      const status: HalalReport["status"] =
        data.assetType !== "stock"
          ? "unsupported"
          : data.status === "halal"
            ? "compliant"
            : data.status === "haram"
              ? "non_compliant"
              : data.status === "doubtful"
                ? "questionable"
                : "unknown";
      report = {
        ...unknownHalalReport(symbol, "", now),
        name: data.name,
        status,
        assetType: data.assetType,
        screenedAt: new Date(screened).toISOString(),
        expiresAt: new Date(
          status === "compliant" ? Math.min(now + HALAL_CACHE_MS, screened + HALAL_REPORT_MAX_AGE_MS) : now + 300_000
        ).toISOString(),
        reasons: [
          status === "compliant"
            ? "Provider reports compliant business and financial screens"
            : status === "unsupported"
              ? "Funds, ETFs, crypto and derivatives are outside this stock portfolio"
              : `Provider verdict: ${data.status}`,
        ],
        metrics: {
          debtRatio: data.debtRatio ?? null,
          cashRatio: data.cashRatio ?? null,
          prohibitedRevenueRatio: data.revenueRatio ?? null,
        },
      };
      report = currentHalalReport(report, now);
    } catch (error) {
      report = unknownHalalReport(
        symbol,
        error instanceof z.ZodError
          ? "Screening response is missing valid dated evidence"
          : error instanceof Error
            ? error.message
            : "Screening provider unavailable"
      );
    }
    try {
      const ttl = Math.max(60, Math.ceil((Date.parse(report.expiresAt) - Date.now()) / 1000));
      await this.cache?.put(key, JSON.stringify(report), { expirationTtl: ttl });
    } catch {
      // The freshly fetched assessment remains usable if caching is unavailable.
    }
    return report;
  }
}
