import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { validateApprovalToken } from "../policy/approval";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
import { type HalalReport, unknownHalalReport } from "../providers/halal";
import type { D1Client } from "../storage/d1/client";
import { MahoragaMcpAgent } from "./agent";

vi.mock("agents/mcp", () => ({ McpAgent: class {} }));
vi.mock("../policy/approval", () => ({
  validateApprovalToken: vi.fn(),
  generateApprovalToken: vi.fn(),
  consumeApprovalToken: vi.fn(),
}));
vi.mock("../storage/d1/queries/tool-logs", () => ({ insertToolLog: vi.fn() }));
vi.mock("../storage/d1/queries/risk-state", () => ({
  getRiskState: vi.fn().mockResolvedValue({ kill_switch_active: false, daily_loss_usd: 0, cooldown_until: null }),
  enableKillSwitch: vi.fn(),
  disableKillSwitch: vi.fn(),
}));

type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function setup() {
  const handlers = new Map<string, Handler>();
  const createOrder = vi
    .fn()
    .mockResolvedValue({ id: "order", symbol: "TEST", qty: "1", side: "buy", type: "market", status: "new" });
  const alpaca = {
    trading: {
      getAccount: vi.fn().mockResolvedValue({ equity: 100, cash: 100, buying_power: 100 }),
      getPositions: vi.fn().mockResolvedValue([]),
      getClock: vi.fn().mockResolvedValue({ is_open: true }),
      createOrder,
    },
  } as unknown as AlpacaProviders;
  const screen = vi.fn().mockResolvedValue(unknownHalalReport("TEST", "Provider unavailable"));
  const agent = Object.assign(Object.create(MahoragaMcpAgent.prototype), {
    env: {} as Env,
    policyConfig: getDefaultPolicyConfig({} as Env),
    screening: { screen },
    server: { registerTool: (name: string, _options: unknown, handler: Handler) => handlers.set(name, handler) },
  }) as MahoragaMcpAgent;
  const db = { run: vi.fn() } as unknown as D1Client;
  (agent as unknown as { registerOrderTools(db: D1Client, alpaca: AlpacaProviders): void }).registerOrderTools(
    db,
    alpaca
  );
  (agent as unknown as { registerOptionsTools(): void }).registerOptionsTools();
  vi.mocked(validateApprovalToken).mockResolvedValue({
    valid: true,
    approval_id: "approved",
    order_params: {
      symbol: "TEST",
      side: "buy",
      asset_class: "us_equity",
      notional: 8,
      order_type: "market",
      time_in_force: "day",
    },
  });
  return { handlers, createOrder, screen, alpaca };
}

beforeEach(() => vi.clearAllMocks());

describe("MCP order submission halal enforcement", () => {
  it("rejects a previously approved buy when current screening is unavailable", async () => {
    const { handlers, createOrder, screen } = setup();
    const result = await handlers.get("orders-submit")!({ approval_token: "previously-approved" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("halal_eligibility");
    expect(screen).toHaveBeenCalledWith("TEST");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("permits an approved stock purchase with current matching screening and risk checks", async () => {
    const { handlers, createOrder, screen } = setup();
    screen.mockResolvedValue({
      ...unknownHalalReport("TEST", "Current test screen"),
      status: "compliant",
      assetType: "stock",
      screenedAt: new Date().toISOString(),
    } satisfies HalalReport);
    const result = await handlers.get("orders-submit")!({ approval_token: "approved" });
    expect(result.isError).not.toBe(true);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("blocks an old options approval before attempting to submit the order", async () => {
    const { handlers } = setup();
    const result = await handlers.get("options-order-submit")!({ approval_token: "old-option-approval" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Options purchases are outside");
  });
});
