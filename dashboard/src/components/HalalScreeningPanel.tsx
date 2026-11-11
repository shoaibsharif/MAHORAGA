import { useState } from "react";
import type { HalalReport } from "../types";
import { Panel } from "./Panel";

type Density = "compact" | "normal" | "large";
const DENSITY_KEY = "mahoraga_screening_density";
const densities: Array<{ value: Density; label: string }> = [
  { value: "compact", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
];
const layout: Record<Density, { grid: string; text: string }> = {
  compact: { grid: "grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2", text: "text-xs" },
  normal: { grid: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3", text: "text-sm" },
  large: { grid: "grid-cols-1 xl:grid-cols-2 gap-4", text: "text-base" },
};

function storedDensity(): Density {
  try {
    const value = localStorage.getItem(DENSITY_KEY);
    return value === "compact" || value === "large" ? value : "normal";
  } catch {
    return "normal";
  }
}

const labels: Record<HalalReport["status"], string> = {
  compliant: "Screened compliant",
  non_compliant: "Blocked: noncompliant",
  questionable: "Blocked: review required",
  unknown: "Blocked: no valid evidence",
  stale: "Blocked: invalid or expired evidence",
  recheck_due: "Compliant when last checked",
  unsupported: "Blocked: outside stock portfolio",
};

function percent(value: number | null): string {
  return value === null ? "Unavailable" : `${(value * 100).toFixed(2)}%`;
}

export function HalalScreeningPanel({ reports }: { reports?: Record<string, HalalReport> }) {
  const [density, setDensity] = useState<Density>(storedDensity);
  const entries = Object.values(reports ?? {}).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const { grid, text } = layout[density];
  const choose = (value: Density) => {
    setDensity(value);
    try {
      localStorage.setItem(DENSITY_KEY, value);
    } catch {
      // The choice still applies for this visit when storage is unavailable.
    }
  };
  return (
    <Panel
      title="HALAL SCREENING"
      titleRight={
        <fieldset className="flex border border-hud-line/60 rounded overflow-hidden">
          <legend className="sr-only">Card size</legend>
          {densities.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={density === value}
              onClick={() => choose(value)}
              className={`hud-label px-3 py-2 focus-visible:outline focus-visible:outline-2 ${
                density === value ? "bg-hud-primary text-hud-bg" : "hover:text-hud-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </fieldset>
      }
    >
      <p className="text-sm text-hud-text-dim mb-4">
        Candidates are discovered dynamically. Purchases require an AAOIFI screen confirmed with the provider within the
        hour. Missing evidence blocks purchases; exits remain available.
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-hud-text">
          No stocks screened yet. Evidence will appear as the agent researches candidates.
        </p>
      ) : (
        <ul className={`grid ${grid} ${text}`}>
          {entries.map((report) => {
            const status =
              report.status === "compliant" && Date.parse(report.expiresAt) <= Date.now()
                ? "recheck_due"
                : report.status;
            const passed = status === "compliant" || status === "recheck_due";
            return (
              <li key={report.symbol} className="border border-hud-line/30 rounded p-3 min-w-0">
                <div
                  className={`flex flex-wrap justify-between gap-x-2 gap-y-1 ${density === "compact" ? "" : "mb-2"}`}
                >
                  <span className="font-semibold text-hud-text break-all">{report.symbol}</span>
                  <span className={passed ? "text-hud-success" : "text-hud-warning"}>{labels[status]}</span>
                </div>
                {density !== "compact" && (
                  <>
                    <p className="text-hud-text-dim break-words">{report.reasons.join("; ")}</p>
                    <p className="text-hud-text-dim mt-2">
                      {report.provider} ·{" "}
                      {report.screenedAt
                        ? `Screened ${new Date(report.screenedAt).toLocaleDateString()}`
                        : "Screening date unavailable"}{" "}
                      · Last checked {new Date(report.checkedAt).toLocaleString()}
                    </p>
                    <dl className="mt-2 space-y-1">
                      <div className="flex flex-wrap justify-between gap-2">
                        <dt>Debt ratio</dt>
                        <dd>{percent(report.metrics.debtRatio)}</dd>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2">
                        <dt>Interest-bearing cash ratio</dt>
                        <dd>{percent(report.metrics.cashRatio)}</dd>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2">
                        <dt>Impermissible revenue ratio</dt>
                        <dd>{percent(report.metrics.prohibitedRevenueRatio)}</dd>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2">
                        <dt>Dividend purification rate</dt>
                        <dd>{percent(report.purificationRatio)}</dd>
                      </div>
                    </dl>
                    <a
                      className="inline-block mt-3 py-1 text-hud-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
                      href={report.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View screening source for {report.symbol}
                    </a>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
