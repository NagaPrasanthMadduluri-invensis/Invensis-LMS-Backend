import { orderIntakeSchema } from "./orders.schema.js";
import * as ordersService from "./orders.service.js";

export async function intake(req, res) {
  const payload = orderIntakeSchema.parse(req.body);
  // HMAC-authenticated machine caller → no user; audit records actor as system (null).
  const result = await ordersService.ingestOrder(null, payload, req.ip);
  res.status(201).json({ result });
}
