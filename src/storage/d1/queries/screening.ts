import type { FundamentalContext } from "../../../providers/fundamentals";
import type { HalalReport } from "../../../providers/halal";

/** Where screening results are kept between requests. */
export interface ScreeningStore {
  get(symbol: string): Promise<HalalReport | null>;
  put(report: HalalReport): Promise<void>;
}

export class D1ScreeningStore implements ScreeningStore {
  constructor(private db: D1Database) {}

  async get(symbol: string): Promise<HalalReport | null> {
    const row = await this.db
      .prepare("SELECT report_json FROM halal_screenings WHERE symbol = ?")
      .bind(symbol)
      .first<{ report_json: string }>();
    return row ? (JSON.parse(row.report_json) as HalalReport) : null;
  }

  async put(report: HalalReport): Promise<void> {
    const json = JSON.stringify(report);
    await this.db.batch([
      // History first, so it compares against the row the upsert is about to replace.
      this.db
        .prepare(
          `INSERT INTO halal_screening_history (symbol, provider, status, screened_at, checked_at, report_json)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE NOT EXISTS (
             SELECT 1 FROM halal_screenings
             WHERE symbol = ?1 AND provider = ?2 AND status = ?3 AND IFNULL(screened_at, '') = IFNULL(?4, '')
           )`
        )
        .bind(report.symbol, report.provider, report.status, report.screenedAt, report.checkedAt, json),
      this.db
        .prepare(
          `INSERT INTO halal_screenings (symbol, provider, status, screened_at, checked_at, expires_at, report_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(symbol) DO UPDATE SET provider = ?2, status = ?3, screened_at = ?4, checked_at = ?5,
             expires_at = ?6, report_json = ?7`
        )
        .bind(
          report.symbol,
          report.provider,
          report.status,
          report.screenedAt,
          report.checkedAt,
          report.expiresAt,
          json
        ),
    ]);
  }
}

export async function getStoredFundamentals(db: D1Database, symbol: string): Promise<FundamentalContext | null> {
  const row = await db
    .prepare("SELECT context_json FROM sec_fundamentals WHERE symbol = ?")
    .bind(symbol)
    .first<{ context_json: string }>();
  return row ? (JSON.parse(row.context_json) as FundamentalContext) : null;
}

export async function storeFundamentals(db: D1Database, context: FundamentalContext): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sec_fundamentals (symbol, checked_at, context_json) VALUES (?1, ?2, ?3)
       ON CONFLICT(symbol) DO UPDATE SET checked_at = ?2, context_json = ?3`
    )
    .bind(context.symbol, context.checkedAt, JSON.stringify(context))
    .run();
}
