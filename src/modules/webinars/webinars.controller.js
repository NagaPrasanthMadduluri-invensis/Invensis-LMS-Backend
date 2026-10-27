import { createWebinarSchema, updateWebinarSchema } from "./webinars.schema.js";
import * as svc from "./webinars.service.js";

// Any authenticated user (learner or sponsor) — powers the banner.
export async function getCurrent(req, res) {
  res.json(await svc.getCurrentWebinar());
}

export async function list(req, res) {
  res.json(await svc.listWebinars());
}

export async function create(req, res) {
  const body = createWebinarSchema.parse(req.body);
  res.status(201).json(await svc.createWebinar(req.user.user_id, body, req.ip));
}

export async function update(req, res) {
  const body = updateWebinarSchema.parse(req.body);
  res.json(await svc.updateWebinar(req.user.user_id, req.params.id, body, req.ip));
}

export async function remove(req, res) {
  res.json(await svc.deleteWebinar(req.user.user_id, req.params.id, req.ip));
}
