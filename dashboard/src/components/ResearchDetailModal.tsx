import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SignalResearch } from "../types";

const verdictColor: Record<SignalResearch["verdict"], string> = {
  BUY: "text-hud-success",
  WAIT: "text-hud-warning",
  SKIP: "text-hud-error",
};

function money(value: number | null | undefined): string {
  if (value == null) return "Unavailable";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString()}`;
}

function percent(value: number | null | undefined, signed = false): string {
  if (value == null) return "Unavailable";
  return `${signed && value > 0 ? "+" : ""}${value}%`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-hud-line/40 pt-4">
      <h3 className="hud-label mb-2">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-hud-text-dim">{label}</dt>
          <dd className="text-hud-text-bright break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface ResearchDetailModalProps {
  symbol: string;
  research: SignalResearch;
  onClose: () => void;
}

/** The full research verdict for one stock: the reasoning, every flag, and the evidence behind it. */
export function ResearchDetailModal({ symbol, research, onClose }: ResearchDetailModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = `research-${symbol}`;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClose]);

  const history = research.priceHistory;
  const valuation = research.valuation;
  const trend = research.fundamentals?.trend;
  const halal = research.halal;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      {/* The scrim is a real button so a click outside the dialog closes it without handlers on plain elements. */}
      <button
        type="button"
        aria-label="Close research details"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/70 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="hud-panel relative w-full sm:max-w-2xl max-h-[92dvh] flex flex-col pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-hud-line shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl text-hud-text-bright">
              {symbol} <span className={`font-bold ${verdictColor[research.verdict]}`}>{research.verdict}</span>
            </h2>
            <p className="text-sm text-hud-text-dim mt-1">
              {(research.confidence * 100).toFixed(0)}% confidence · {research.entry_quality} entry · analysed{" "}
              {new Date(research.timestamp).toLocaleString()}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="hud-button shrink-0 min-h-11 focus-visible:outline focus-visible:outline-2"
          >
            Close
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          <p className="text-base text-hud-text leading-relaxed">{research.reasoning}</p>

          {research.catalysts.length > 0 && (
            <Section title="Catalysts">
              <ul className="space-y-1.5 text-sm text-hud-success list-disc pl-5">
                {research.catalysts.map((catalyst) => (
                  <li key={catalyst}>{catalyst}</li>
                ))}
              </ul>
            </Section>
          )}

          {research.red_flags.length > 0 && (
            <Section title="Red flags">
              <ul className="space-y-1.5 text-sm text-hud-error list-disc pl-5">
                {research.red_flags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </Section>
          )}

          {history && (
            <Section title="Price history">
              <Facts
                items={[
                  ["Last close", `$${history.lastClose}`],
                  ["5 days", percent(history.returnPct.d5, true)],
                  ["20 days", percent(history.returnPct.d20, true)],
                  ["60 days", percent(history.returnPct.d60, true)],
                  ["Below period high", percent(history.belowHighPct)],
                  ["Vs 50-day average", percent(history.vsMovingAveragePct.sma50, true)],
                  ["Vs 200-day average", percent(history.vsMovingAveragePct.sma200, true)],
                  ["RSI (14)", history.rsi14 == null ? "Unavailable" : String(history.rsi14)],
                  ["Volume vs average", history.relativeVolume == null ? "Unavailable" : `${history.relativeVolume}×`],
                ]}
              />
            </Section>
          )}

          <Section title="Valuation">
            {valuation ? (
              <Facts
                items={[
                  ["Market cap", money(valuation.marketCapUsd)],
                  ["Price to sales", valuation.priceToSales == null ? "Unavailable" : `${valuation.priceToSales}×`],
                  [
                    "Price to earnings",
                    valuation.priceToEarnings == null
                      ? valuation.annualNetIncomeNegative
                        ? "Loss-making"
                        : "Unavailable"
                      : `${valuation.priceToEarnings}×`,
                  ],
                ]}
              />
            ) : (
              <p className="text-sm text-hud-text-dim">Unavailable: no usable share count in the SEC data.</p>
            )}
          </Section>

          {trend && trend.quarters.length > 0 && (
            <Section title="Quarterly results">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-hud-text-dim text-left">
                      <th scope="col" className="font-normal pr-3 pb-1">
                        Quarter ending
                      </th>
                      <th scope="col" className="font-normal pr-3 pb-1 text-right">
                        Revenue
                      </th>
                      <th scope="col" className="font-normal pr-3 pb-1 text-right">
                        Year on year
                      </th>
                      <th scope="col" className="font-normal pb-1 text-right">
                        Net margin
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...trend.quarters].reverse().map((quarter) => (
                      <tr key={quarter.end} className="border-t border-hud-line/20">
                        <td className="pr-3 py-1 whitespace-nowrap">{quarter.end}</td>
                        <td className="pr-3 py-1 text-right whitespace-nowrap">{money(quarter.revenue)}</td>
                        <td className="pr-3 py-1 text-right whitespace-nowrap">
                          {percent(quarter.revenueYoYPct, true)}
                        </td>
                        <td className="py-1 text-right whitespace-nowrap">{percent(quarter.netMarginPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {halal && (
            <Section title="Halal screening">
              <Facts
                items={[
                  ["Provider", halal.provider],
                  ["Status", halal.status.replaceAll("_", " ")],
                  [
                    "Purification rate",
                    halal.purificationRatio == null ? "Unavailable" : `${(halal.purificationRatio * 100).toFixed(2)}%`,
                  ],
                ]}
              />
            </Section>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
