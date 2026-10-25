import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
import type { D1Client } from "../storage/d1/client";
import { createPolicyBroker } from "./policy-broker";

function setup(fractionable = true) {
  const createOrder = vi.fn().mockResolvedValue({ status: "new" });
  const alpaca = {
    trading: {
      getAsset: vi.fn().mockResolvedValue({ tradable: true, fractionable, exchange: "NASDAQ" }),
      getAccount: vi.fn().mockResolvedValue({ cash: 100, equity: 100, buying_power: 400 }),
      getPositions: vi.fn().mockResolvedValue([]),
      getClock: vi.fn().mockResolvedValue({ is_open: true }),
      createOrder,
    },
  } as unknown as AlpacaProviders;
  const broker = createPolicyBroker({
    alpaca,
    policyConfig: getDefaultPolicyConfig({ DEFAULT_MAX_NOTIONAL_PER_TRADE: "none" } as Env),
    db: null,
    log: vi.fn(),
    cryptoSymbols: [],
    allowedExchanges: ["NASDAQ"],
  });
  return { broker, createOrder };
}

describe("small-account stock orders", () => {
  it("sends dollars, not whole-share quantities, for fractional entries", async () => {
    const { broker, createOrder } = setup();
    expect(await broker.buy("TEST", 8, "test signal")).toBe(true);
    expect(createOrder).toHaveBeenCalledWith({
      symbol: "TEST",
      notional: 8,
      side: "buy",
      type: "market",
      time_in_force: "day",
    });
  });

  it("blocks non-fractionable assets before submitting an order", async () => {
    const { broker, createOrder } = setup(false);
    expect(await broker.buy("TEST", 8, "test signal")).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("preserves the percentage limit without a fixed dollar cap", async () => {
    const { broker, createOrder } = setup();
    expect(await broker.buy("TEST", 11, "test signal")).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("blocks sub-dollar stock entries before submitting an order", async () => {
    const { broker, createOrder } = setup();
    expect(await broker.buy("TEST", 0.99, "test signal")).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("trading sleeve", () => {
  it("buys a fractional slice of the sleeve inside a large paper account", async () => {
    const { broker, createOrder } = setupSleeve();
    expect(await broker.buy("TEST", 8, "sleeve entry")).toBe(true);
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ notional: 8 }));
  });

  it("rejects an order above 10% of the sleeve even when the broker account is large", async () => {
    const { broker, createOrder } = setupSleeve();
    expect(await broker.buy("TEST", 11, "too large for the sleeve")).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("stops reserving sleeve cash after earlier buys in the same cycle", async () => {
    const { broker, createOrder } = setupSleeve({ maxPositionPct: 1 });
    expect(await broker.buy("AAA", 80, "first")).toBe(true);
    expect(await broker.buy("BBB", 30, "second")).toBe(false);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("records a losing close against the sleeve and blocks the next buy at the 2% stop", async () => {
    const harness = setupSleeve({
      positions: [{ symbol: "TEST", unrealized_pl: -2.5, market_value: 7.5, cost_basis: 10 }],
    });
    expect(await harness.broker.sell("TEST", "stop loss")).toBe(true);
    expect(harness.realizedPnl).toBe(-2.5);
    expect(harness.run).toHaveBeenCalledWith(expect.stringContaining("daily_loss_usd"), expect.arrayContaining([2.5]));
    expect(harness.run).toHaveBeenCalledWith(expect.stringContaining("cooldown_until"), expect.any(Array));

    harness.risk.daily_loss_usd = 2.5;
    expect(await harness.broker.buy("NEXT", 8, "after the loss")).toBe(false);
  });
});

function setupSleeve(options: { maxPositionPct?: number; positions?: Array<Record<string, unknown>> } = {}) {
  const createOrder = vi.fn().mockResolvedValue({ status: "new" });
  const closePosition = vi.fn().mockResolvedValue({});
  let reserved = 0;
  let realizedPnl = 0;
  const risk = {
    id: 1,
    kill_switch_active: 0,
    kill_switch_reason: null,
    kill_switch_at: null,
    daily_loss_usd: 0,
    daily_loss_reset_at: new Date().toISOString(),
    last_loss_at: null,
    cooldown_until: null,
    updated_at: new Date().toISOString(),
  };
  const run = vi.fn().mockResolvedValue({});
  const db = {
    executeOne: vi.fn().mockImplementation(async () => ({ ...risk })),
    run,
  } as unknown as D1Client;
  const policyConfig = getDefaultPolicyConfig({ DEFAULT_MAX_NOTIONAL_PER_TRADE: "none" } as Env);
  if (options.maxPositionPct) policyConfig.max_position_pct_equity = options.maxPositionPct;
  const alpaca = {
    trading: {
      getAsset: vi.fn().mockResolvedValue({ tradable: true, fractionable: true, exchange: "NASDAQ" }),
      getAccount: vi.fn().mockResolvedValue({ cash: 100_000, equity: 100_000, buying_power: 100_000 }),
      getPositions: vi.fn().mockResolvedValue(options.positions ?? []),
      getClock: vi.fn().mockResolvedValue({ is_open: true }),
      createOrder,
      closePosition,
    },
  } as unknown as AlpacaProviders;
  const broker = createPolicyBroker({
    alpaca,
    policyConfig,
    db,
    log: vi.fn(),
    cryptoSymbols: [],
    allowedExchanges: ["NASDAQ"],
    sleeve: {
      getStartingEquity: () => 100,
      getRealizedPnl: () => realizedPnl,
      addRealizedPnl: (delta) => {
        realizedPnl = Math.round((realizedPnl + delta) * 100) / 100;
      },
      getReserved: () => reserved,
    },
    onBuy: (_symbol, notional) => {
      reserved += notional;
    },
  });
  return {
    broker,
    createOrder,
    run,
    risk,
    get realizedPnl() {
      return realizedPnl;
    },
  };
}
