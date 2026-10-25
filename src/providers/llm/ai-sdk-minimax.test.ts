import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.d";
import { createLLMProvider, getConfiguredProviders, isLLMConfigured } from "./factory";

function message(text = '{"verdict":"WAIT"}', stopReason = "end_turn") {
  return {
    id: "msg_minimax_test",
    type: "message",
    role: "assistant",
    model: "MiniMax-M3.1-Flash",
    content: [
      { type: "thinking", thinking: "Private reasoning", signature: "test-signature" },
      { type: "text", text },
    ],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 100 },
  };
}

function mockResponse(data = message()) {
  const fetchMock = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function provider() {
  return createLLMProvider({
    LLM_PROVIDER: "ai-sdk",
    LLM_MODEL: "minimax/MiniMax-M3.1-Flash",
    MINIMAX_API_KEY: "minimax-test-key",
    OPENAI_API_KEY: "unrelated-openai-key",
    OPENAI_BASE_URL: "https://unrelated.example/v1",
  } as Env)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("MiniMax AI SDK integration", () => {
  it("uses the maintained provider's Anthropic endpoint and separates reasoning from the answer", async () => {
    const fetchMock = mockResponse();
    const messages = [
      { role: "system" as const, content: "Research the supplied signal. Return JSON." },
      { role: "user" as const, content: "Analyze the signal." },
    ];
    const result = await provider().complete({ messages, max_tokens: 250, response_format: { type: "json_object" } });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/anthropic/v1/messages");
    expect(new Headers(request.headers).get("x-api-key")).toBe("minimax-test-key");
    expect(new Headers(request.headers).get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(request.body as string);
    expect(body).toMatchObject({
      model: "MiniMax-M3.1-Flash",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(JSON.stringify(body.system)).toContain("valid JSON object");
    expect(JSON.stringify(body.system)).toContain("Research the supplied signal");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Analyze the signal." }] }]);
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("temperature");
    expect(messages).toHaveLength(2);
    expect(result).toEqual({
      content: '{"verdict":"WAIT"}',
      usage: { prompt_tokens: 40, completion_tokens: 100, total_tokens: 140 },
    });
  });

  it("supports an analyst model override and a larger output budget", async () => {
    const fetchMock = mockResponse();
    await provider().complete({
      model: "minimax/MiniMax-M3",
      messages: [{ role: "user", content: "Analyze" }],
      max_tokens: 16384,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({ model: "MiniMax-M3", max_tokens: 16384 });
  });

  it("requires the MiniMax key when its model is selected", () => {
    for (const key of [undefined, "", "   "]) {
      const env = { LLM_PROVIDER: "ai-sdk", LLM_MODEL: "minimax/MiniMax-M3.1-Flash", MINIMAX_API_KEY: key } as Env;
      expect(createLLMProvider(env)).toBeNull();
      expect(isLLMConfigured(env)).toBe(false);
    }
    expect(getConfiguredProviders({ MINIMAX_API_KEY: "test" } as Env)).toContain("minimax");
  });

  it.each(["not JSON", "null", "[]", "42"])("rejects an invalid JSON object: %s", async (text) => {
    mockResponse(message(text));
    await expect(
      provider().complete({ messages: [{ role: "user", content: "Test" }], response_format: { type: "json_object" } })
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("rejects truncated responses, even if the partial text is valid JSON", async () => {
    mockResponse(message('{"verdict":"BUY"}', "max_tokens"));
    await expect(provider().complete({ messages: [{ role: "user", content: "Test" }] })).rejects.toThrow("length");
  });

  it("rejects reasoning without a final answer", async () => {
    mockResponse({ ...message(), content: [{ type: "thinking", thinking: "Still thinking", signature: "test" }] });
    await expect(provider().complete({ messages: [{ role: "user", content: "Test" }] })).rejects.toThrow(
      "incomplete answer"
    );
  });

  it("reports authentication errors without retrying", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid key" } }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().complete({ messages: [{ role: "user", content: "Test" }] })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("Invalid key"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
