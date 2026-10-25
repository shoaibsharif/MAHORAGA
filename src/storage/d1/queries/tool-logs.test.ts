import { describe, expect, it, vi } from "vitest";
import type { D1Client } from "../client";
import { insertToolLog } from "./tool-logs";

describe("tool logging", () => {
  it("resolves the input hash before binding values to D1", async () => {
    const run = vi.fn(async (_query: string, params: unknown[]) => {
      for (const value of params) {
        if (value !== null && !["string", "number"].includes(typeof value)) {
          throw new Error("D1 bindings must contain serializable primitive values");
        }
      }
    });
    const db = { run } as unknown as D1Client;
    const id = await insertToolLog(db, {
      request_id: "request-1",
      tool_name: "symbol-research",
      input: { symbol: "SPY" },
      output: { report_length: 200 },
    });

    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(run).toHaveBeenCalledOnce();
    const params = run.mock.calls[0]![1];
    expect(params[3]).toMatch(/^[a-f0-9]{64}$/);
    expect(params[4]).toBe('{"symbol":"SPY"}');
    expect(params[5]).toBe('{"report_length":200}');
  });
});
