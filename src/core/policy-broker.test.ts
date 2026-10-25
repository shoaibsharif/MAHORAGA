import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
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
