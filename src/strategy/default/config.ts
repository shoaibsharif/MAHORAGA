/**
 * Default Strategy Configuration
 *
 * SOURCE_CONFIG: How much to trust each data source
 * DEFAULT_CONFIG: Base trading parameters
 * DEFAULT_STATE: Initial state for a fresh agent
 */

import type { AgentConfig, AgentState } from "../../core/types";
import type { Env } from "../../env.d";

// ── Source weights & tuning ──────────────────────────────────────────────────

export const SOURCE_CONFIG = {
  weights: {
    stocktwits: 0.85,
    twitter_fintwit: 0.95,
    twitter_news: 0.9,
    sec_8k: 0.95,
    sec_4: 0.9,
    sec_13f: 0.7,
  },
  decayHalfLifeMinutes: 120,
};

// ── Default agent configuration ──────────────────────────────────────────────

export const DEFAULT_CONFIG: AgentConfig = {
  data_poll_interval_ms: 30_000,
  analyst_interval_ms: 120_000,
  premarket_plan_window_minutes: 5,
  market_open_execute_window_minutes: 2,
  max_position_value: null,
  min_trade_notional: 1,
  starting_equity: 100,
  max_positions: 5,
  min_sentiment_score: 0.3,
  min_analyst_confidence: 0.6,
  take_profit_pct: 10,
  stop_loss_pct: 5,
  hard_stop_loss_pct: 15,
  open_sell_delay_minutes: 30,
  position_size_pct_of_cash: 10,
  stale_position_enabled: true,
  stale_min_hold_hours: 24,
  stale_max_hold_days: 3,
  stale_min_gain_pct: 5,
  stale_mid_hold_days: 2,
  stale_mid_min_gain_pct: 3,
  stale_social_volume_decay: 0.3,
  llm_provider: "openai-raw",
  llm_model: "gpt-4o-mini",
  llm_analyst_model: "gpt-4o",
  llm_min_hold_minutes: 30,
  options_enabled: false,
  options_min_confidence: 0.8,
  options_max_pct_per_trade: 0.02,
  options_min_dte: 30,
  options_max_dte: 60,
  options_target_delta: 0.45,
  options_min_delta: 0.3,
  options_max_delta: 0.7,
  options_stop_loss_pct: 50,
  options_take_profit_pct: 100,
  crypto_enabled: false,
  crypto_symbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
  crypto_momentum_threshold: 2.0,
  crypto_max_position_value: 1000,
  crypto_take_profit_pct: 10,
  crypto_stop_loss_pct: 5,
  ticker_blacklist: [],
  allowed_exchanges: ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
};

export function getInitialAgentConfig(env: Pick<Env, "LLM_PROVIDER" | "LLM_MODEL">): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    llm_provider: env.LLM_PROVIDER || DEFAULT_CONFIG.llm_provider,
    llm_model: env.LLM_MODEL || DEFAULT_CONFIG.llm_model,
    llm_analyst_model: env.LLM_MODEL || DEFAULT_CONFIG.llm_analyst_model,
  };
}

// ── Default agent state ──────────────────────────────────────────────────────

export const DEFAULT_STATE: AgentState = {
  config: DEFAULT_CONFIG,
  signalCache: [],
  positionEntries: {},
  socialHistory: {},
  socialSnapshotCache: {},
  socialSnapshotCacheUpdatedAt: 0,
  logs: [],
  costTracker: { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 },
  lastDataGatherRun: 0,
  lastAnalystRun: 0,
  lastResearchRun: 0,
  lastPositionResearchRun: 0,
  signalResearch: {},
  halalReports: {},
  lastHalalReviewRun: 0,
  lastAnalystModelCall: 0,
  positionResearch: {},
  stopLossReviews: {},
  stopLossReviewFailedAt: {},
  stalenessAnalysis: {},
  twitterConfirmations: {},
  twitterDailyReads: 0,
  twitterDailyReadReset: 0,
  lastKnownNextOpenMs: null,
  premarketPlan: null,
  lastPremarketPlanDayEt: null,
  lastClockIsOpen: null,
  realizedPnl: 0,
  enabled: false,
};
