import { describe, expect, it } from "vitest";
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
