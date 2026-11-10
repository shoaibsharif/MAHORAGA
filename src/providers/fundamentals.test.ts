import { describe, expect, it } from "vitest";
import { extractMetrics, latestShareCount } from "./fundamentals";

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
});
