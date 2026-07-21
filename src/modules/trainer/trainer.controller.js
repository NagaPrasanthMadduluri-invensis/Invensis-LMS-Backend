import { updateTopicsSchema, markAttendanceSchema } from "./trainer.schema.js";
import * as trainerService from "./trainer.service.js";

export async function listMyTrainings(req, res) {
  res.json(await trainerService.listMyTrainings(req.user.user_id));
}

export async function getTrainingDetail(req, res) {
  res.json(await trainerService.getTrainingDetail(req.user.user_id, req.params.trainingRef));
}

export async function updateSessionTopics(req, res) {
  const { planned_topics } = updateTopicsSchema.parse(req.body);
  const session = await trainerService.updateSessionTopics(
    req.user.user_id,
    req.params.sessionId,
    planned_topics,
    req.ip
  );
  res.json({ session });
}

export async function getSessionAttendance(req, res) {
  res.json(await trainerService.getSessionAttendance(req.user.user_id, req.params.sessionId));
}

export async function markSessionAttendance(req, res) {
  const { records } = markAttendanceSchema.parse(req.body);
  res.json(
    await trainerService.markSessionAttendance(req.user.user_id, req.params.sessionId, records, req.ip)
  );
}

export async function listFeedback(req, res) {
  res.json(await trainerService.listFeedback(req.user.user_id));
}

export async function getTrainingFeedback(req, res) {
  res.json(await trainerService.getTrainingFeedback(req.user.user_id, req.params.trainingRef));
}
