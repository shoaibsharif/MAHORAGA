import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
import { type HalalReport, unknownHalalReport } from "../providers/halal";
import type { D1Client } from "../storage/d1/client";
import { createPolicyBroker } from "./policy-broker";

function screenedStock(symbol: string): HalalReport {
  return {
    ...unknownHalalReport(symbol, "Test screening evidence"),
    status: "compliant",
    assetType: "stock",
    screenedAt: new Date().toISOString(),
  };
}

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
    screening: { screen: async (symbol) => screenedStock(symbol) },
  });
  return { broker, createOrder };
}

describe("small-account stock orders", () => {
  it("never submits a buy when no screening service has supplied evidence", async () => {
    const createOrder = vi.fn();
    const alpaca = {
      trading: {
        getAsset: vi.fn().mockResolvedValue({ tradable: true, fractionable: true, exchange: "NASDAQ" }),
        getAccount: vi.fn().mockResolvedValue({ cash: 100, equity: 100, buying_power: 100 }),
        getPositions: vi.fn().mockResolvedValue([]),
        getClock: vi.fn().mockResolvedValue({ is_open: true }),
        createOrder,
      },
    } as unknown as AlpacaProviders;
    const broker = createPolicyBroker({
      alpaca,
      policyConfig: getDefaultPolicyConfig({} as Env),
      db: null,
      log: vi.fn(),
      cryptoSymbols: [],
      allowedExchanges: ["NASDAQ"],
    });
    expect(await broker.buy("UNSCREENED", 8, "LLM says BUY with 100% confidence")).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });
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

describe("holding a purchase until it settles", () => {
  const position = { symbol: "TEST", unrealized_pl: -2.5, market_value: 7.5, cost_basis: 10 };
  const buy = (filledAt: string, filledQty = "0.5") => ({
    side: "buy",
    filled_qty: filledQty,
    filled_at: filledAt,
    submitted_at: filledAt,
  });

  it("does not sell shares bought earlier the same day, even at the stop loss", async () => {
    const harness = setupSleeve({ positions: [position], orders: [buy(new Date().toISOString())] });
    expect(await harness.broker.sell("TEST", "Stop loss at -25.0%")).toBe(false);
    expect(harness.closePosition).not.toHaveBeenCalled();
    expect(harness.realizedPnl).toBe(0);
    expect(harness.listOrders).toHaveBeenCalledWith(expect.objectContaining({ symbols: ["TEST"], status: "all" }));
  });

  it("sells once the purchase is from an earlier day", async () => {
    const harness = setupSleeve({
      positions: [position],
      // An unfilled order from today and a sale from today do not count as a purchase.
      orders: [
        buy(new Date(Date.now() - 3 * 86_400_000).toISOString()),
        buy(new Date().toISOString(), "0"),
        { ...buy(new Date().toISOString()), side: "sell" },
      ],
    });
    expect(await harness.broker.sell("TEST", "Stop loss at -25.0%")).toBe(true);
    expect(harness.closePosition).toHaveBeenCalledWith("TEST");
  });

  it("does not sell when the purchase date cannot be confirmed", async () => {
    const harness = setupSleeve({ positions: [position] });
    harness.listOrders.mockRejectedValueOnce(new Error("orders unavailable"));
    expect(await harness.broker.sell("TEST", "Stop loss at -25.0%")).toBe(false);
    expect(harness.closePosition).not.toHaveBeenCalled();
  });
});

function setupSleeve(
  options: {
    maxPositionPct?: number;
    positions?: Array<Record<string, unknown>>;
    orders?: Array<Record<string, unknown>>;
  } = {}
) {
  const createOrder = vi.fn().mockResolvedValue({ status: "new" });
  const closePosition = vi.fn().mockResolvedValue({});
  const listOrders = vi.fn().mockResolvedValue(options.orders ?? []);
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
      listOrders,
    },
  } as unknown as AlpacaProviders;
  const broker = createPolicyBroker({
    alpaca,
    policyConfig,
    db,
    log: vi.fn(),
    cryptoSymbols: [],
    allowedExchanges: ["NASDAQ"],
    screening: { screen: async (symbol) => screenedStock(symbol) },
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
    closePosition,
    listOrders,
    run,
    risk,
    get realizedPnl() {
      return realizedPnl;
    },
  };
}
