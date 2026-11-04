import { z } from "zod";

export const STATUSES = ["pending", "shipped", "cancelled"] as const;

const OrderSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  customer: z.string(),
  item: z.string(),
  status: z.enum(STATUSES),
  customerNote: z.string(), // free text written by end customers: untrusted
});

export type Order = z.infer<typeof OrderSchema>;
export type OrderStatus = Order["status"];
export type Store = ReturnType<typeof createStore>;

// Tenant scoping lives here. Every function takes the tenant id first, and the
// tools always pass the id from the verified token, so no query can read or
// write across tenants.
// ponytail: in-memory demo data, reset on restart. A real store applies the
// same rule in SQL (WHERE tenant_id = $1) or with row-level security.
export function createStore(seed: unknown) {
  const orders = z.array(OrderSchema).parse(seed); // parsed copies; the seed is never mutated

  const get = (tenantId: string, id: string): Order | undefined =>
    orders.find((o) => o.tenantId === tenantId && o.id === id);

  return {
    get,
    list: (tenantId: string, status?: OrderStatus): Order[] =>
      orders.filter((o) => o.tenantId === tenantId && (status === undefined || o.status === status)),
    setStatus(tenantId: string, id: string, status: OrderStatus): void {
      const order = get(tenantId, id);
      if (order) order.status = status;
    },
  };
}
