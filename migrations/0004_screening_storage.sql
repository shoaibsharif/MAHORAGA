-- Latest halal screening result per symbol. Replaces the KV cache.
CREATE TABLE halal_screenings (
  symbol TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  screened_at TEXT,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);

-- One row each time a symbol's provider, status or assessment date changes.
CREATE TABLE halal_screening_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  screened_at TEXT,
  checked_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE INDEX idx_halal_screening_history_symbol ON halal_screening_history(symbol, id);

-- Latest SEC financial context per symbol. Replaces the KV cache.
CREATE TABLE sec_fundamentals (
  symbol TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  context_json TEXT NOT NULL
);
