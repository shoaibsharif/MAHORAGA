import type { HalalReport } from "../types";
import { Panel } from "./Panel";

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
  const entries = Object.values(reports ?? {}).sort((a, b) => a.symbol.localeCompare(b.symbol));
  return (
    <Panel title="HALAL SCREENING" titleRight="INDIVIDUAL STOCKS">
      <p className="text-sm text-hud-text-dim mb-4">
        Candidates are discovered dynamically. Purchases require an AAOIFI screen confirmed with the provider within the
        hour. Missing evidence blocks purchases; exits remain available.
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-hud-text">
          No stocks screened yet. Evidence will appear as the agent researches candidates.
        </p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {entries.map((report) => {
            const status =
              report.status === "compliant" && Date.parse(report.expiresAt) <= Date.now()
                ? "recheck_due"
                : report.status;
            const passed = status === "compliant" || status === "recheck_due";
            return (
              <li key={report.symbol} className="border border-hud-line/30 rounded p-3 min-w-0">
                <div className="flex flex-wrap justify-between gap-2 mb-2">
                  <span className="font-semibold text-hud-text break-all">{report.symbol}</span>
                  <span className={passed ? "text-hud-success text-sm" : "text-hud-warning text-sm"}>
                    {labels[status]}
                  </span>
                </div>
                <p className="text-sm text-hud-text-dim break-words">{report.reasons.join("; ")}</p>
                <p className="text-sm text-hud-text-dim mt-2">
                  {report.provider} ·{" "}
                  {report.screenedAt
                    ? `Screened ${new Date(report.screenedAt).toLocaleDateString()}`
                    : "Screening date unavailable"}{" "}
                  · Last checked {new Date(report.checkedAt).toLocaleString()}
                </p>
                <dl className="text-sm mt-2 space-y-1">
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
                  className="inline-block mt-3 py-1 text-sm text-hud-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
                  href={report.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View screening source for {report.symbol}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
