import {
  updateTrainingSchema,
  addParticipantSchema,
  onboardTrainerSchema,
  updateTrainerSchema,
  updateParticipantSchema,
  listParticipantsQuerySchema,
  cancelEnrolmentSchema,
  transferEnrolmentSchema,
  analyticsQuerySchema,
  createSurveySchema,
} from "./admin.schema.js";
import * as adminService from "./admin.service.js";

export async function createSurvey(req, res) {
  const body = createSurveySchema.parse(req.body);
  const survey = await adminService.createSurvey(req.user.user_id, req.params.trainingId, body, req.ip);
  res.status(201).json({ survey });
}

export async function listTrainingSurveys(req, res) {
  res.json(await adminService.listTrainingSurveys(req.params.trainingId));
}

export async function listSurveyResponses(req, res) {
  res.json(await adminService.listSurveyResponses(req.params.surveyId));
}

export async function getTrainingAttendance(req, res) {
  res.json(await adminService.getTrainingAttendance(req.params.trainingId));
}

export async function getDashboard(req, res) {
  res.json(await adminService.getDashboard());
}

export async function getAnalytics(req, res) {
  const filters = analyticsQuerySchema.parse(req.query);
  res.json(await adminService.getAnalytics(filters));
}

export async function listTrainings(req, res) {
  const result = await adminService.listTrainings();
  res.json(result);
}

export async function getTrainingDetail(req, res) {
  const detail = await adminService.getTrainingDetail(req.params.trainingId);
  res.json(detail);
}

export async function listTrainers(req, res) {
  const includeInactive = req.query.include_inactive === "true" || req.query.include_inactive === "1";
  const result = await adminService.listTrainers({ includeInactive });
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

export async function onboardTrainer(req, res) {
  const body = onboardTrainerSchema.parse(req.body);
  const trainer = await adminService.onboardTrainer(req.user.user_id, body, req.ip);
  res.status(201).json({ trainer });
}

export async function getTrainerDetail(req, res) {
  res.json(await adminService.getTrainerDetail(req.params.trainerId));
}

export async function updateTrainer(req, res) {
  const body = updateTrainerSchema.parse(req.body);
  const trainer = await adminService.updateTrainer(req.user.user_id, req.params.trainerId, body, req.ip);
  res.json({ trainer });
}

export async function listParticipants(req, res) {
  const query = listParticipantsQuerySchema.parse(req.query);
  res.json(await adminService.listParticipants(query));
}

export async function getParticipantDetail(req, res) {
  res.json(await adminService.getParticipantDetail(req.params.participantId));
}

export async function updateParticipant(req, res) {
  const body = updateParticipantSchema.parse(req.body);
  const participant = await adminService.updateParticipant(
    req.user.user_id,
    req.params.participantId,
    body,
    req.ip
  );
  res.json({ participant });
}

export async function cancelEnrolment(req, res) {
  const { reason } = cancelEnrolmentSchema.parse(req.body);
  const result = await adminService.cancelEnrolment(req.user.user_id, req.params.enrolmentId, reason, req.ip);
  res.json(result);
}

export async function completeEnrolment(req, res) {
  const result = await adminService.completeEnrolment(req.user.user_id, req.params.enrolmentId, req.ip);
  res.json(result);
}

export async function completeAllEnrolments(req, res) {
  const result = await adminService.completeAllEnrolments(req.user.user_id, req.params.trainingId, req.ip);
  res.json(result);
}

export async function transferEnrolment(req, res) {
  const { training_id, reason } = transferEnrolmentSchema.parse(req.body);
  const result = await adminService.transferEnrolment(
    req.user.user_id,
    req.params.enrolmentId,
    training_id,
    reason,
    req.ip
  );
  res.json(result);
}
