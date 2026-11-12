import { describe, expect, it } from "vitest";
import { safeValidateAgentConfig } from "../../schemas/agent-config";
import { DEFAULT_CONFIG, getInitialAgentConfig } from "./config";

describe("initial cloud agent configuration", () => {
  it("uses the deployed LLM configuration for a fresh agent", () => {
    const config = getInitialAgentConfig({ LLM_PROVIDER: "ai-sdk", LLM_MODEL: "minimax/MiniMax-M3.1-Flash" });
    expect(config.llm_provider).toBe("ai-sdk");
    expect(config.llm_model).toBe("minimax/MiniMax-M3.1-Flash");
    expect(config.llm_analyst_model).toBe(config.llm_model);
    expect(config.starting_equity).toBe(100);
    expect(config.options_enabled).toBe(false);
    expect(config.crypto_enabled).toBe(false);
    expect(DEFAULT_CONFIG.llm_provider).toBe("openai-raw");
  });

  it("retains defaults when no deployment model is specified", () => {
    expect(getInitialAgentConfig({})).toEqual(DEFAULT_CONFIG);
  });
});

describe("stop-loss settings", () => {
  it("accepts the defaults and fills the newer settings in for a stored configuration that lacks them", () => {
    expect(safeValidateAgentConfig(DEFAULT_CONFIG).success).toBe(true);
    const { hard_stop_loss_pct: _hard, open_sell_delay_minutes: _delay, ...older } = DEFAULT_CONFIG;
    const result = safeValidateAgentConfig(older);
    expect(result.success && result.data.hard_stop_loss_pct).toBe(15);
    expect(result.success && result.data.open_sell_delay_minutes).toBe(30);
  });

  it("rejects a hard stop that sits above the level where the review starts", () => {
    const result = safeValidateAgentConfig({ ...DEFAULT_CONFIG, stop_loss_pct: 10, hard_stop_loss_pct: 8 });
    expect(result.success).toBe(false);
  });
});
