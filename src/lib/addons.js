import { inArray } from "drizzle-orm";
import { db } from "../config/db.js";
import { orders } from "../db/schema.js";

/**
 * Add-ons purchased on an order, pulled from the stored xCRM payload
 * (`payload.order.addon_items`). Only the fields the portal shows are kept, and
 * nameless entries are dropped so a non-empty array always means "there is
 * something to show". Pure — safe to call on any order payload (or none).
 */
export function extractAddons(payload) {
  const items = payload?.order?.addon_items;
  if (!Array.isArray(items)) return [];
  return items
    .map((a) => ({ name: a?.addon_name ?? a?.name ?? null, quantity: a?.quantity ?? null }))
    .filter((a) => a.name);
}

/**
 * Batch-resolve add-ons for many orders at once, to attach them to a list of
 * enrolments without a query per row. Returns a Map of orderId -> addons[];
 * order ids with no add-ons (or no row) are simply absent. Nullish ids are
 * ignored, so a manually-added seat (no order) contributes nothing.
 */
export async function addonsByOrderIds(orderIds) {
  const ids = [...new Set((orderIds ?? []).filter(Boolean))];
  const map = new Map();
  if (ids.length === 0) return map;

  const rows = await db
    .select({ id: orders.id, payload: orders.payload })
    .from(orders)
    .where(inArray(orders.id, ids));

  for (const r of rows) {
    const addons = extractAddons(r.payload);
    if (addons.length) map.set(r.id, addons);
  }
  return map;
}
