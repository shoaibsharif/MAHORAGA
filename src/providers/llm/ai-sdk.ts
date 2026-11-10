import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createMinimax } from "@minimax-ai/ai-sdk-provider";
import { generateText } from "ai";
import { createError, ErrorCode } from "../../lib/errors";
import type { CompletionParams, CompletionResult, LLMProvider } from "../types";

/**
 * Supported AI SDK providers and their environment variable mapping
 */
export const SUPPORTED_PROVIDERS = {
  openai: { envKey: "OPENAI_API_KEY", name: "OpenAI" },
  anthropic: { envKey: "ANTHROPIC_API_KEY", name: "Anthropic" },
  google: { envKey: "GOOGLE_GENERATIVE_AI_API_KEY", name: "Google" },
  xai: { envKey: "XAI_API_KEY", name: "xAI (Grok)" },
  deepseek: { envKey: "DEEPSEEK_API_KEY", name: "DeepSeek" },
  minimax: { envKey: "MINIMAX_API_KEY", name: "MiniMax" },
} as const;

export type SupportedProvider = keyof typeof SUPPORTED_PROVIDERS;

/**
 * Popular models per provider for dashboard UI
 */
export const PROVIDER_MODELS: Record<SupportedProvider, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "o1", "o1-mini"],
  anthropic: ["claude-3-7-sonnet-latest", "claude-sonnet-4-0", "claude-opus-4-1", "claude-3-5-haiku-latest"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-3-pro-preview"],
  xai: ["grok-4", "grok-3", "grok-4-fast-reasoning"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  minimax: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
};

export interface AISDKConfig {
  /** Model identifier in format "provider/model" (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4") */
  model: string;
  /** API keys for each provider */
  apiKeys: Partial<Record<SupportedProvider, string>>;
  /** Optional OpenAI base URL override (e.g., OpenAI-compatible proxy). */
  openaiBaseUrl?: string;
}

type ProviderFactory =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>
  | ReturnType<typeof createXai>
  | ReturnType<typeof createDeepSeek>
  | ReturnType<typeof createMinimax>;

/**
 * AI SDK Provider - Supports multiple AI providers via Vercel AI SDK
 *
 * Supports OpenAI, Anthropic, Google, xAI, DeepSeek, and MiniMax
 * Model format: "provider/model" (e.g., "openai/gpt-4o", "xai/grok-4")
 */
export class AISDKProvider implements LLMProvider {
  private providers: Partial<Record<SupportedProvider, ProviderFactory>>;
  private defaultModel: string;

  constructor(config: AISDKConfig) {
    this.providers = {};

    // Initialize providers based on available API keys
    if (config.apiKeys.openai) {
      const rawBaseUrl = config.openaiBaseUrl?.trim().replace(/\/+$/, "");
      const openaiOptions: { apiKey: string; baseURL?: string } = { apiKey: config.apiKeys.openai };
      if (rawBaseUrl) {
        openaiOptions.baseURL = rawBaseUrl;
      }
      this.providers.openai = createOpenAI(openaiOptions);
    }
    if (config.apiKeys.anthropic) {
      this.providers.anthropic = createAnthropic({ apiKey: config.apiKeys.anthropic });
    }
    if (config.apiKeys.google) {
      this.providers.google = createGoogleGenerativeAI({ apiKey: config.apiKeys.google });
    }
    if (config.apiKeys.xai) {
      this.providers.xai = createXai({ apiKey: config.apiKeys.xai });
    }
    if (config.apiKeys.deepseek) {
      this.providers.deepseek = createDeepSeek({ apiKey: config.apiKeys.deepseek });
    }
    if (config.apiKeys.minimax) {
      this.providers.minimax = createMinimax({ apiKey: config.apiKeys.minimax });
    }

    if (Object.keys(this.providers).length === 0) {
      throw createError(ErrorCode.INVALID_INPUT, "At least one provider API key is required");
    }

    this.defaultModel = config.model;
  }

  /**
   * Get list of available providers based on configured API keys
   */
  getAvailableProviders(): SupportedProvider[] {
    return Object.keys(this.providers) as SupportedProvider[];
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    try {
      const modelSpec = params.model ?? this.defaultModel;

      // Parse provider/model format (supports both / and : separators)
      const separator = modelSpec.includes(":") ? ":" : "/";
      const parts = modelSpec.split(separator);
      const providerName = (parts[0] ?? "openai").toLowerCase() as SupportedProvider;
      const modelId = parts.slice(1).join(separator) || modelSpec;

      // Get provider instance
      const provider = this.providers[providerName];
      if (!provider) {
        const available = this.getAvailableProviders().join(", ");
        throw createError(
          ErrorCode.INVALID_INPUT,
          `Provider '${providerName}' not configured. Available: ${available}`
        );
      }

      const isMiniMax = providerName === "minimax";
      const isAnthropic = providerName === "anthropic";
      // These models think before answering, so they need room in the output budget and a strict JSON reminder.
      const reasons = isMiniMax || isAnthropic;
      const jsonOutput = reasons && params.response_format?.type === "json_object";
      const instructions = params.messages.filter((msg) => msg.role === "system").map((msg) => msg.content);
      if (jsonOutput) {
        instructions.push(
          "Return exactly one valid JSON object. Do not include markdown fences or text outside the object."
        );
      }
      const result = await generateText({
        model: provider(modelId),
        messages: params.messages.flatMap((msg) =>
          msg.role === "system" ? [] : [{ role: msg.role, content: msg.content }]
        ),
        ...(instructions.length > 0 && { instructions: instructions.join("\n\n") }),
        ...(isMiniMax
          ? {
              // Reasoning shares the output budget with the final answer.
              maxOutputTokens: Math.max(params.max_tokens ?? 8192, 8192),
              providerOptions: { minimax: { thinking: { type: "adaptive" }, effort: "medium" } },
              abortSignal: AbortSignal.timeout(60_000),
              maxRetries: 0,
            }
          : isAnthropic
            ? {
                // Current Claude models reject sampling parameters such as temperature; effort sets thinking depth.
                maxOutputTokens: Math.max(params.max_tokens ?? 16_000, 16_000),
                providerOptions: { anthropic: anthropicOptions(modelId) },
                abortSignal: AbortSignal.timeout(120_000),
              }
            : {
                temperature: params.temperature ?? 0.7,
                maxOutputTokens: params.max_tokens ?? 1024,
              }),
      });

      if (reasons) {
        const name = isMiniMax ? "MiniMax" : "Claude";
        if (result.finishReason !== "stop" || !result.text.trim()) {
          throw createError(ErrorCode.PROVIDER_ERROR, `${name} returned an incomplete answer (${result.finishReason})`);
        }
        if (jsonOutput) {
          const parsed: unknown = JSON.parse(result.text.replace(/```json\n?|```/g, "").trim());
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw createError(ErrorCode.PROVIDER_ERROR, `${name} must return a JSON object`);
          }
        }
      }

      return {
        content: result.text,
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
          total_tokens: result.usage?.totalTokens ?? 0,
        },
      };
    } catch (error) {
      throw createError(ErrorCode.PROVIDER_ERROR, `AI SDK error: ${String(error)}`);
    }
  }
}

/**
 * Medium effort suits a short JSON decision. Models that support it fall back to another
 * Claude model when a safety classifier declines, instead of returning nothing.
 */
export function anthropicOptions(modelId: string): { effort: "medium"; fallbacks?: "default" } {
  const fallbackCapable = /^claude-(opus-5-5|sonnet-5-5|fable-5-[12])$/.test(modelId);
  return fallbackCapable ? { effort: "medium", fallbacks: "default" } : { effort: "medium" };
}

/** Legacy config format for backward compatibility */
export interface LegacyAISDKConfig {
  model: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

export function createAISDKProvider(config: AISDKConfig | LegacyAISDKConfig): AISDKProvider {
  // Handle legacy config format
  if ("openaiApiKey" in config || "anthropicApiKey" in config) {
    const legacyConfig = config as LegacyAISDKConfig;
    return new AISDKProvider({
      model: legacyConfig.model,
      apiKeys: {
        openai: legacyConfig.openaiApiKey,
        anthropic: legacyConfig.anthropicApiKey,
      },
    });
  }
  return new AISDKProvider(config as AISDKConfig);
}
