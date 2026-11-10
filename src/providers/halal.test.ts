import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HALAL_CACHE_MS,
  HALAL_REPORT_MAX_AGE_MS,
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
    const cache = { get: vi.fn().mockResolvedValue(fresh), put: vi.fn() } as unknown as KVNamespace;
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
});
