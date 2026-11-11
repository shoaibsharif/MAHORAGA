import { describe, expect, it } from "vitest";
import { extractMetrics, extractTrend, latestShareCount } from "./fundamentals";

describe("SEC financial context", () => {
  it("preserves the period, filing date and source concept for financial facts", () => {
    const metrics = extractMetrics({
      Revenues: {
        units: {
          USD: [
            { val: 900, start: "2025-01-01", end: "2025-12-31", filed: "2026-02-01", form: "10-K" },
            { val: 300, start: "2026-04-01", end: "2026-06-30", filed: "2026-08-01", form: "10-Q" },
            { val: 600, start: "2026-01-01", end: "2026-06-30", filed: "2026-08-01", form: "10-Q" },
          ],
        },
      },
      CashAndCashEquivalentsAtCarryingValue: {
        units: { USD: [{ val: 0, end: "2026-06-30", filed: "2026-08-01", form: "10-Q" }] },
      },
    });
    expect(metrics.revenue).toEqual({
      concept: "Revenues",
      value: 300,
      unit: "USD",
      start: "2026-04-01",
      end: "2026-06-30",
      filed: "2026-08-01",
    });
    expect(metrics.cash?.value).toBe(0);
    expect(metrics.operatingCashFlow).toBeUndefined();
  });

  it("ignores future and invalid facts rather than inventing a zero", () => {
    const metrics = extractMetrics({
      Revenues: {
        units: {
          USD: [
            { val: 100, end: "2999-01-01", filed: "2999-01-01", form: "10-K" },
            { val: Number.NaN, end: "2025-12-31", filed: "2026-02-01", form: "10-K" },
          ],
        },
      },
    });
    expect(metrics).toEqual({});
  });

  it("keeps only full fiscal years for annual figures", () => {
    const annual = extractMetrics(
      {
        Revenues: {
          units: {
            USD: [
              { val: 900, start: "2025-01-01", end: "2025-12-31", filed: "2026-02-01", form: "10-K" },
              { val: 300, start: "2025-10-01", end: "2025-12-31", filed: "2026-02-01", form: "10-K" },
              { val: 600, start: "2026-01-01", end: "2026-06-30", filed: "2026-08-01", form: "10-Q" },
            ],
          },
        },
        CashAndCashEquivalentsAtCarryingValue: {
          units: { USD: [{ val: 5, end: "2025-12-31", filed: "2026-02-01", form: "10-K" }] },
        },
      },
      true
    );
    expect(annual.revenue?.value).toBe(900);
    expect(annual.cash).toBeUndefined();
  });

  it("sums share classes reported on the latest date and ignores older counts", () => {
    expect(
      latestShareCount([
        { val: 100, end: "2026-01-01", filed: "2026-02-01", form: "10-K" },
        { val: 60, end: "2026-10-01", filed: "2026-10-30", form: "10-Q" },
        { val: 40, end: "2026-10-01", filed: "2026-10-30", form: "10-Q" },
      ])
    ).toEqual({ value: 100, end: "2026-10-01", filed: "2026-10-30" });
    expect(latestShareCount([])).toBeNull();
  });

  it("builds quarterly and annual trends, deriving the unfiled fourth quarter", () => {
    const q = (val: number, start: string, end: string, filed: string, form = "10-Q") => ({
      val,
      start,
      end,
      filed,
      form,
    });
    const trend = extractTrend({
      Revenues: {
        units: {
          USD: [
            q(100, "2024-01-01", "2024-03-31", "2024-05-01"),
            q(400, "2024-01-01", "2024-12-31", "2025-02-01", "10-K"),
            q(150, "2025-01-01", "2025-03-31", "2025-05-01"),
            q(160, "2025-04-01", "2025-06-30", "2025-08-01"),
            // Year-to-date figures cover six and nine months and are not quarters.
            q(310, "2025-01-01", "2025-06-30", "2025-08-01"),
            q(170, "2025-07-01", "2025-09-30", "2025-11-01"),
            q(700, "2025-01-01", "2025-12-31", "2026-02-01", "10-K"),
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            q(15, "2025-01-01", "2025-03-31", "2025-05-01"),
            // A restated figure filed later replaces the original.
            q(12, "2025-01-01", "2025-03-31", "2025-08-01"),
            q(70, "2025-01-01", "2025-12-31", "2026-02-01", "10-K"),
          ],
        },
      },
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [q(90, "2025-01-01", "2025-12-31", "2026-02-01", "10-K")] },
      },
    });
    expect(trend?.quarters.map((quarter) => quarter.end)).toEqual([
      "2024-03-31",
      "2025-03-31",
      "2025-06-30",
      "2025-09-30",
      "2025-12-31",
    ]);
    expect(trend?.quarters[1]).toMatchObject({ revenue: 150, netIncome: 12, netMarginPct: 8, revenueYoYPct: 50 });
    expect(trend?.quarters[4]).toMatchObject({ revenue: 220, derived: true });
    expect(trend?.fiscalYears.at(-1)).toMatchObject({
      end: "2025-12-31",
      revenue: 700,
      netIncome: 70,
      netMarginPct: 10,
      revenueYoYPct: 75,
      operatingCashFlow: 90,
    });
  });

  it("returns no trend when a company reports nothing usable", () => {
    expect(extractTrend({})).toBeNull();
  });
});
