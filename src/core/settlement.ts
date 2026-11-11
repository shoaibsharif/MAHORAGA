import type { Order } from "../providers/types";

const newYorkDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar date in New York, where US trading days are counted. */
export function newYorkDate(time: number | string): string {
  return newYorkDay.format(new Date(time));
}

/**
 * Whether any of these orders bought shares on the current New York date.
 *
 * US stock purchases settle on the next trading day. Shares bought today are not sold until then, so
 * the agent only ever sells shares it has finished paying for and taken delivery of.
 */
export function boughtToday(orders: Order[], now = Date.now()): boolean {
  const today = newYorkDate(now);
  return orders.some(
    (order) =>
      order.side === "buy" &&
      Number(order.filled_qty) > 0 &&
      newYorkDate(order.filled_at ?? order.submitted_at) === today
  );
}
