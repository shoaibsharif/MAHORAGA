import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HALAL_CACHE_MS,
  HALAL_REPORT_MAX_AGE_MS,
  HALAL_SH_PROVIDER,
  HalalScreeningService,
  halalBlockReason,
  unknownHalalReport,
} from "./halal";

afterEach(() => vi.restoreAllMocks());

function badge(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "TEST",
    name: "Test Company",
    status: "halal",
    assetType: "stock",
    screenedAt: new Date().toISOString(),
    debtRatio: 0.1,
    cashRatio: null,
    revenueRatio: 0.02,
    ...overrides,
  };
}

function provider(body: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return { service: new HalalScreeningService(undefined, fetcher), fetcher };
}

describe("live halal evidence", () => {
  it("screens a dynamically supplied symbol and preserves unavailable financial fields", async () => {
    const { service, fetcher } = provider(badge());
    const result = await service.screen("test");
    expect(halalBlockReason(result, "TEST")).toBeNull();
    expect(result.metrics.cashRatio).toBeNull();
    expect(result.purificationRatio).toBeNull();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://halalscreener.app/api/embed/badge?symbol=TEST");
  });

  it("calls fetch without a this binding, which Workers rejects as an illegal invocation", async () => {
    const { service, fetcher } = provider(badge());
    await service.screen("TEST");
    expect(fetcher.mock.contexts[0]).toBeUndefined();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it.each([
    ["noncompliant", { status: "haram" }],
    ["questionable", { status: "doubtful" }],
    ["unrecognized status", { status: "unknown" }],
    ["fund", { assetType: "etf" }],
    ["different issuer", { symbol: "OTHER" }],
    ["undated", { screenedAt: undefined }],
    ["invalid date", { screenedAt: "invalid" }],
    ["future assessment", { screenedAt: new Date(Date.now() + 86_400_000).toISOString() }],
    ["old assessment", { screenedAt: new Date(Date.now() - HALAL_REPORT_MAX_AGE_MS).toISOString() }],
    ["invalid financial figure", { debtRatio: "10%" }],
    ["contradictory published ratios", { debtRatio: 0.5 }],
  ])("blocks %s evidence", async (_name, overrides) => {
    const { service } = provider(badge(overrides));
    expect(halalBlockReason(await service.screen("TEST"), "TEST")).not.toBeNull();
  });

  it("does not turn an outage into approval", async () => {
    const { service } = provider({}, 429);
    expect((await service.screen("TEST")).status).toBe("unknown");
  });

  it("blocks unsupported symbols without making a provider request", async () => {
    const { service, fetcher } = provider(badge());
    expect((await service.screen("BTC/USD")).status).toBe("unsupported");
    expect((await service.screen("TEST261218C00100000")).status).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous requests", async () => {
    const { service, fetcher } = provider(badge());
    await Promise.all([service.screen("TEST"), service.screen("TEST")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses dated cache evidence but refreshes expired evidence", async () => {
    const { service } = provider(badge());
    const fresh = await service.screen("TEST");
    const cache = { get: vi.fn().mockResolvedValue(fresh), put: vi.fn() };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(badge({ status: "haram" }))));
    const cached = new HalalScreeningService(cache, fetcher);
    expect((await cached.screen("TEST")).status).toBe("compliant");
    expect(fetcher).not.toHaveBeenCalled();
    fresh.checkedAt = new Date(Date.now() - HALAL_CACHE_MS).toISOString();
    fresh.expiresAt = new Date(Date.now() - 1).toISOString();
    expect((await cached.screen("TEST")).status).toBe("non_compliant");
  });

  it("never accepts evidence for a different symbol or a different authority", async () => {
    const { service } = provider(badge());
    const report = await service.screen("TEST");
    expect(halalBlockReason(report, "OTHER")).not.toBeNull();
    expect(halalBlockReason({ ...report, provider: "LLM" }, "TEST")).not.toBeNull();
    expect(halalBlockReason({ ...report, screenedAt: null }, "TEST")).not.toBeNull();
    expect(
      halalBlockReason({ ...report, checkedAt: new Date(Date.now() - HALAL_CACHE_MS).toISOString() }, "TEST")
    ).not.toBeNull();
    expect(halalBlockReason(unknownHalalReport("TEST", "Missing evidence"), "TEST")).toBe("Missing evidence");
  });

  it("keeps a failed lookup for an uncovered symbol far longer than a transient error", async () => {
    const missing = await provider({}, 404).service.screen("TEST");
    const outage = await provider({}, 503).service.screen("TEST");
    expect(missing.status).toBe("unknown");
    expect(Date.parse(missing.expiresAt) - Date.now()).toBeGreaterThan(3_600_000);
    expect(Date.parse(outage.expiresAt) - Date.now()).toBeLessThan(300_000);
  });

  it("ignores a stored report from a different provider", async () => {
    const { service } = provider(badge());
    const stored = { ...(await service.screen("TEST")), provider: HALAL_SH_PROVIDER };
    const store = { get: vi.fn().mockResolvedValue(stored), put: vi.fn() };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(badge({ status: "haram" }))));
    expect((await new HalalScreeningService(store, fetcher).screen("TEST")).status).toBe("non_compliant");
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});

function halalSh(overrides: Record<string, unknown> = {}, determination: Record<string, unknown> = {}) {
  return {
    data: {
      symbol: "TEST",
      instrument_id: "TEST",
      name: "Test Company",
      methodology: "aaoifi-ss21@2026.1",
      as_of: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      determination: { status: "compliant", confidence: 0.95, explanation: null, withheld: null, ...determination },
      screens: {
        business_activity: { result: "pass" },
        debt_to_market_cap: { result: "pass", value: 0.08, threshold: 0.3 },
        cash_to_market_cap: { result: "pass", value: 0.05, threshold: 0.3 },
        prohibited_revenue: { result: "pass", value: 0.012, threshold: 0.05 },
      },
      purification: { required: true, percentage: 1.2, amount_per_1000: 12 },
      stability: { rating: "watch", drivers: [] },
      ...overrides,
    },
    meta: { request_id: "req_test" },
  };
}

function halalShProvider(body: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return { service: new HalalScreeningService(undefined, fetcher, "hsh_test_key"), fetcher };
}

describe("halal.sh evidence", () => {
  it("still accepts a determination from the previous quarter's filing", async () => {
    const { service } = halalShProvider(halalSh({ as_of: new Date(Date.now() - 120 * 86_400_000).toISOString() }));
    expect(halalBlockReason(await service.screen("TEST"), "TEST")).toBeNull();
  });

  it("accepts a month-old compliant determination with its ratios and purification rate", async () => {
    const { service, fetcher } = halalShProvider(halalSh());
    const report = await service.screen("test");
    expect(halalBlockReason(report, "TEST")).toBeNull();
    expect(report).toMatchObject({
      provider: HALAL_SH_PROVIDER,
      status: "compliant",
      assetType: "stock",
      metrics: { debtRatio: 0.08, cashRatio: 0.05, prohibitedRevenueRatio: 0.012 },
      purificationRatio: 0.012,
      confidence: 0.95,
    });
    expect(report.reasons[0]).toContain("stability rated watch");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.halal.sh/v1/instruments/TEST/compliance");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-API-Key": "hsh_test_key" });
  });

  it.each([
    ["non-compliant verdict", halalSh({}, { status: "non-compliant" })],
    ["low-confidence verdict", halalSh({}, { confidence: 0.6 })],
    [
      "pending analysis",
      halalSh({ as_of: null, screens: null }, { status: "pending", withheld: { reason: "no_data_source" } }),
    ],
    ["unrecognized future status", halalSh({}, { status: "under-review" })],
    ["fund methodology", halalSh({ methodology: "aaoifi-ss57@2026.1" })],
    ["different issuer", halalSh({ symbol: "OTHER" })],
    ["undated determination", halalSh({ as_of: null })],
    [
      "determination older than two filing periods",
      halalSh({ as_of: new Date(Date.now() - 151 * 86_400_000).toISOString() }),
    ],
    ["ratio contradicting the verdict", halalSh({ screens: { debt_to_market_cap: { result: "pass", value: 0.5 } } })],
  ])("blocks a %s", async (_name, body) => {
    const { service } = halalShProvider(body);
    expect(halalBlockReason(await service.screen("TEST"), "TEST")).not.toBeNull();
  });

  it("does not treat a rejected key or rate limit as approval", async () => {
    for (const status of [401, 403, 429]) {
      const { service } = halalShProvider({ error: { code: "x", message: "y" } }, status);
      expect((await service.screen("TEST")).status).toBe("unknown");
    }
  });
});
