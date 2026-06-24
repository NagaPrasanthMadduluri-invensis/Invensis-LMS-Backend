import { orderIntakeSchema } from "./orders.schema.js";
import * as ordersService from "./orders.service.js";

export async function intake(req, res) {
  const payload = orderIntakeSchema.parse(req.body);
  const result = await ordersService.ingestOrder(req.user.user_id, payload, req.ip);
  res.status(201).json({ result });
}
