import { updateTrainingSchema, addParticipantSchema } from "./admin.schema.js";
import * as adminService from "./admin.service.js";

export async function listTrainings(req, res) {
  const result = await adminService.listTrainings();
  res.json(result);
}

export async function getTrainingDetail(req, res) {
  const detail = await adminService.getTrainingDetail(req.params.trainingId);
  res.json(detail);
}

export async function listTrainers(req, res) {
  const result = await adminService.listTrainers();
  res.json(result);
}

export async function addParticipant(req, res) {
  const body = addParticipantSchema.parse(req.body);
  const result = await adminService.addParticipant(
    req.user.user_id,
    req.params.trainingId,
    body,
    req.ip
  );
  res.status(201).json(result);
}

export async function updateTraining(req, res) {
  const body = updateTrainingSchema.parse(req.body);
  const training = await adminService.updateTraining(
    req.user.user_id,
    req.params.trainingId,
    body,
    req.ip
  );
  res.json({ training });
}
