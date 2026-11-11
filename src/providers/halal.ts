import { z } from "zod";
import type { Env } from "../env.d";
import { D1ScreeningStore, type ScreeningStore } from "../storage/d1/queries/screening";

export const HALAL_PROVIDER = "HalalScreener";
export const HALAL_SH_PROVIDER = "halal.sh";
export const HALAL_METHODOLOGY = "AAOIFI Standard 21";
export const HALAL_REPORT_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const HALAL_CACHE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How old a provider's own assessment may be. HalalScreener re-dates its badge often;
 * halal.sh only recomputes when a company files. The longest gap between filings is from the
 * third-quarter report to the annual report, about 110 days, so 150 leaves room for its analysis.
 */
const MAX_ASSESSMENT_AGE_MS: Record<string, number> = {
  [HALAL_PROVIDER]: HALAL_REPORT_MAX_AGE_MS,
  [HALAL_SH_PROVIDER]: 150 * DAY_MS,
};
/**
 * How long a compliant verdict may be relied on before the provider is asked again. halal.sh
 * changes a verdict only when a company files, so a daily check is enough; purchases always
 * ask for a check made within the hour.
 */
const RECHECK_MS: Record<string, number> = {
  [HALAL_PROVIDER]: HALAL_CACHE_MS,
  [HALAL_SH_PROVIDER]: DAY_MS,
};
/** A verdict changes when a company files, not within hours, so failed and uncovered results are kept. */
const SETTLED_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_TTL_MS = 120_000;
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
const screen = z.object({ result: z.string().nullish(), value: z.number().finite().nullish() }).nullish();
const HalalShSchema = z.object({
  data: z.object({
    symbol: z.string(),
    name: z.string().nullish(),
    methodology: z.string(),
    as_of: z.string().nullish(),
    determination: z.object({
      status: z.string(),
      confidence: z.number().nullish(),
      withheld: z.object({ reason: z.string().nullish() }).nullish(),
    }),
    screens: z.object({ debt_to_market_cap: screen, cash_to_market_cap: screen, prohibited_revenue: screen }).nullish(),
    purification: z
      .object({ percentage: z.number().finite().nullish(), amount_per_1000: z.number().finite().nullish() })
      .nullish(),
    stability: z.object({ rating: z.string().nullish() }).nullish(),
  }),
});

export interface HalalReport {
  symbol: string;
  name: string | null;
  provider: string;
  methodology: string;
  /** `recheck_due` is a compliant verdict whose last provider check is too old to buy on. */
  status: "compliant" | "non_compliant" | "questionable" | "unknown" | "stale" | "recheck_due" | "unsupported";
  assetType: string | null;
  screenedAt: string | null;
  checkedAt: string;
  expiresAt: string;
  sourceUrl: string;
  reasons: string[];
  metrics: { debtRatio: number | null; cashRatio: number | null; prohibitedRevenueRatio: number | null };
  purificationRatio: number | null;
  /** The provider's own data-quality score from 0 to 1, when it publishes one. */
  confidence?: number | null;
}

export interface ScreenOptions {
  /** Ask the provider again unless the stored result was checked within this many milliseconds. */
  maxCheckAgeMs?: number;
}

export interface HalalScreening {
  screen(symbol: string, options?: ScreenOptions): Promise<HalalReport>;
}

export function unknownHalalReport(
  symbol: string,
  reason: string,
  now = Date.now(),
  provider = HALAL_PROVIDER
): HalalReport {
  return {
    symbol,
    name: null,
    provider,
    methodology: HALAL_METHODOLOGY,
    status: "unknown",
    assetType: null,
    screenedAt: null,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RETRY_TTL_MS).toISOString(),
    sourceUrl:
      provider === HALAL_SH_PROVIDER
        ? "https://halal.sh"
        : `https://halalscreener.app/en/stock/${encodeURIComponent(symbol)}`,
    reasons: [reason],
    metrics: { debtRatio: null, cashRatio: null, prohibitedRevenueRatio: null },
    purificationRatio: null,
  };
}

const RECHECK_DUE = "Compliant when last checked; a fresh check is due before buying";

export function halalBlockReason(report: HalalReport | undefined, symbol: string, now = Date.now()): string | null {
  return evidenceProblem(report, symbol, now, true);
}

function evidenceProblem(
  report: HalalReport | undefined,
  symbol: string,
  now: number,
  requireRecentCheck: boolean
): string | null {
  if (!report || report.symbol !== symbol.trim().toUpperCase()) return "No matching halal screening evidence";
  const maxAge = MAX_ASSESSMENT_AGE_MS[report.provider];
  const recheck = RECHECK_MS[report.provider];
  if (!maxAge || !recheck || report.methodology !== HALAL_METHODOLOGY) return "Unrecognized screening authority";
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
  if (now - screened >= maxAge) return "Screening evidence has expired";
  if (requireRecentCheck && (now - checked >= recheck || expires <= now)) return RECHECK_DUE;
  return null;
}

export function currentHalalReport(report: HalalReport, now = Date.now()): HalalReport {
  if (report.status !== "compliant") return report;
  const reason = halalBlockReason(report, report.symbol, now);
  if (!reason) return report;
  // Sound evidence that only needs a fresh provider check is not the same as failed evidence.
  const onlyCheckAge = evidenceProblem(report, report.symbol, now, false) === null;
  return { ...report, status: onlyCheckAge ? "recheck_due" : "stale", reasons: [reason] };
}

/** A provider answered, but has no verdict to give; asking again soon won't change that. */
class NotCovered extends Error {}

export class HalalScreeningService implements HalalScreening {
  private pending = new Map<string, Promise<HalalReport>>();
  private provider: string;

  constructor(
    private store?: ScreeningStore,
    private fetcher: typeof fetch = fetch,
    /** A halal.sh API key switches screening from the free HalalScreener badge to halal.sh. */
    private halalShKey?: string
  ) {
    this.provider = halalShKey ? HALAL_SH_PROVIDER : HALAL_PROVIDER;
  }

  async screen(input: string, options: ScreenOptions = {}): Promise<HalalReport> {
    const symbol = input.trim().toUpperCase();
    if (!SYMBOL.test(symbol)) {
      return {
        ...unknownHalalReport(symbol, "Only individual stock symbols can be screened", Date.now(), this.provider),
        status: "unsupported",
      };
    }
    const key = `${symbol}:${options.maxCheckAgeMs ?? ""}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.load(symbol, options).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async load(symbol: string, options: ScreenOptions): Promise<HalalReport> {
    try {
      const cached = await this.store?.get(symbol);
      const recentEnough =
        options.maxCheckAgeMs === undefined ||
        (!!cached && Date.now() - Date.parse(cached.checkedAt) < options.maxCheckAgeMs);
      const usable = cached?.symbol === symbol && cached.provider === this.provider && recentEnough;
      if (usable && cached.status === "stale" && Date.now() - Date.parse(cached.checkedAt) < RETRY_TTL_MS)
        return cached;
      if (usable && Array.isArray(cached.reasons) && Date.parse(cached.expiresAt) > Date.now()) {
        if (cached.status !== "compliant" || halalBlockReason(cached, symbol) === null) return cached;
      }
    } catch {
      // A storage failure must not substitute for a fresh provider assessment.
    }

    let report: HalalReport;
    try {
      report = currentHalalReport(this.halalShKey ? await this.fromHalalSh(symbol) : await this.fromBadge(symbol));
    } catch (error) {
      report = unknownHalalReport(
        symbol,
        error instanceof z.ZodError
          ? "Screening response is missing valid dated evidence"
          : error instanceof Error
            ? error.message
            : "Screening provider unavailable",
        Date.now(),
        this.provider
      );
      if (error instanceof NotCovered) report.expiresAt = new Date(Date.now() + SETTLED_TTL_MS).toISOString();
    }
    try {
      await this.store?.put(report);
    } catch {
      // The freshly fetched assessment remains usable if storage is unavailable.
    }
    return report;
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    // Workers' fetch throws "Illegal invocation" when called with a `this`, so call it unbound.
    const fetcher = this.fetcher;
    const response = await fetcher(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(8_000),
      // Workers only accepts "follow" or "manual"; a redirect is then rejected by the ok check.
      redirect: "manual",
    });
    if (response.status === 404) throw new NotCovered(`${this.provider} has no record of this symbol`);
    if (!response.ok) throw new Error(`Screening provider returned HTTP ${response.status}`);
    return response;
  }

  private settle(
    symbol: string,
    now: number,
    screened: number,
    fields: Pick<HalalReport, "name" | "status" | "assetType" | "reasons" | "metrics" | "purificationRatio"> & {
      confidence?: number | null;
    }
  ): HalalReport {
    const maxAge = MAX_ASSESSMENT_AGE_MS[this.provider] ?? HALAL_REPORT_MAX_AGE_MS;
    const recheck = RECHECK_MS[this.provider] ?? HALAL_CACHE_MS;
    return {
      ...unknownHalalReport(symbol, "", now, this.provider),
      ...fields,
      screenedAt: new Date(screened).toISOString(),
      expiresAt: new Date(
        fields.status === "compliant" ? Math.min(now + recheck, screened + maxAge) : now + SETTLED_TTL_MS
      ).toISOString(),
    };
  }

  private async fromBadge(symbol: string): Promise<HalalReport> {
    const response = await this.request(
      `https://halalscreener.app/api/embed/badge?symbol=${encodeURIComponent(symbol)}`,
      {}
    );
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
    return this.settle(symbol, now, screened, {
      name: data.name,
      status,
      assetType: data.assetType,
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
      purificationRatio: null,
    });
  }

  private async fromHalalSh(symbol: string): Promise<HalalReport> {
    const response = await this.request(
      `https://api.halal.sh/v1/instruments/${encodeURIComponent(symbol)}/compliance`,
      { "X-API-Key": this.halalShKey ?? "" }
    );
    const { data } = HalalShSchema.parse(await response.json());
    if (data.symbol.toUpperCase() !== symbol) throw new Error("Screening provider returned a different symbol");
    const verdict = data.determination.status;
    if (verdict !== "compliant" && verdict !== "non-compliant") {
      const why = data.determination.withheld?.reason;
      throw new NotCovered(`halal.sh has no verdict for this stock yet${why ? ` (${why.replaceAll("_", " ")})` : ""}`);
    }
    const now = Date.now();
    const screened = Date.parse(data.as_of ?? "");
    if (!Number.isFinite(screened) || screened > now + 300_000)
      throw new Error("Screening provider returned an invalid assessment date");
    // Funds and metal trusts are screened under other standards and are outside this stock portfolio.
    const isStock = data.methodology.startsWith("aaoifi-ss21");
    const confidence = data.determination.confidence ?? null;
    // halal.sh rates confidence below 0.7 as estimated, missing or stale inputs.
    const lowConfidence = confidence !== null && confidence < 0.7;
    const status: HalalReport["status"] = !isStock
      ? "unsupported"
      : verdict === "non-compliant"
        ? "non_compliant"
        : lowConfidence
          ? "questionable"
          : "compliant";
    const rating = data.stability?.rating;
    const perThousand = data.purification?.amount_per_1000;
    const percentage = data.purification?.percentage;
    return this.settle(symbol, now, screened, {
      name: data.name ?? null,
      status,
      assetType: isStock ? "stock" : "fund",
      reasons: [
        status === "compliant"
          ? `Provider reports compliant business and financial screens${rating && rating !== "stable" ? `; stability rated ${rating}` : ""}`
          : status === "unsupported"
            ? "Funds, ETFs, crypto and derivatives are outside this stock portfolio"
            : status === "questionable"
              ? `Provider verdict is compliant but its data confidence is low (${confidence})`
              : "Provider verdict: non-compliant",
      ],
      metrics: {
        debtRatio: data.screens?.debt_to_market_cap?.value ?? null,
        cashRatio: data.screens?.cash_to_market_cap?.value ?? null,
        prohibitedRevenueRatio: data.screens?.prohibited_revenue?.value ?? null,
      },
      // Both fields carry the same rate: percent of revenue, and that amount per 1,000 of dividends.
      purificationRatio: perThousand != null ? perThousand / 1000 : percentage != null ? percentage / 100 : null,
      confidence,
    });
  }
}

/** Screening backed by D1, using halal.sh when its key is configured. */
export function createHalalScreening(env: Pick<Env, "DB" | "HALAL_SH_API_KEY">): HalalScreeningService {
  return new HalalScreeningService(new D1ScreeningStore(env.DB), fetch, env.HALAL_SH_API_KEY?.trim() || undefined);
}
