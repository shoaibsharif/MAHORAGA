import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.d";
import worker from "./index";

const mocks = vi.hoisted(() => ({ proxy: vi.fn(), assets: vi.fn() }));
vi.mock("./durable-objects/mahoraga-harness", () => ({
  MahoragaHarness: class {},
  getHarnessStub: () => ({ fetch: mocks.proxy }),
}));
vi.mock("./durable-objects/session", () => ({
  SessionDO: class {},
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  incrementRequest: vi.fn(),
}));
vi.mock("./mcp/agent", () => ({ createMahoragaMcpServer: vi.fn() }));
vi.mock("./durable-objects/retired-mcp-agent", () => ({ MahoragaMcpAgent: class {} }));
vi.mock("agents/mcp/server", () => ({ createMcpHandler: vi.fn() }));
vi.mock("./jobs/cron", () => ({ handleCronEvent: vi.fn() }));

const context = {} as ExecutionContext;
const environment = () =>
  ({ MAHORAGA_API_TOKEN: "test-token", ENVIRONMENT: "test", ASSETS: { fetch: mocks.assets } }) as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assets.mockResolvedValue(new Response("<html>Dashboard</html>", { headers: { "Content-Type": "text/html" } }));
  mocks.proxy.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
});

describe("deployed dashboard routing", () => {
  it("serves the dashboard at the root", async () => {
    const result = await worker.fetch(new Request("https://app.example/"), environment(), context);
    expect(await result.text()).toContain("Dashboard");
  });

  it.each(["/api/status", "/agent/status", "/mcp"])("requires authentication for %s", async (path) => {
    const result = await worker.fetch(new Request(`https://app.example${path}`), environment(), context);
    expect(result.status).toBe(401);
    expect(mocks.assets).not.toHaveBeenCalled();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });

  it("forwards same-origin API requests with their body, query and authorization", async () => {
    await worker.fetch(
      new Request("https://app.example/api/config?mode=paper", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ starting_equity: 100 }),
      }),
      environment(),
      context
    );
    const request = mocks.proxy.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("http://harness/config?mode=paper");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    expect(await request.json()).toEqual({ starting_equity: 100 });
  });

  it("keeps the existing authenticated agent URL working", async () => {
    await worker.fetch(
      new Request("https://app.example/agent/status", { headers: { Authorization: "Bearer test-token" } }),
      environment(),
      context
    );
    const forwarded = mocks.proxy.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("http://harness/status");
  });

  it("does not replace API errors with the SPA shell", async () => {
    mocks.proxy.mockResolvedValue(new Response("Not found", { status: 404 }));
    const response = await worker.fetch(
      new Request("https://app.example/api/missing", { headers: { Authorization: "Bearer test-token" } }),
      environment(),
      context
    );
    expect(response.status).toBe(404);
    expect(mocks.assets).not.toHaveBeenCalled();
  });
});
