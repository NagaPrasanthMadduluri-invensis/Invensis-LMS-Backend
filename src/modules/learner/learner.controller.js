import * as learnerService from "./learner.service.js";
import { certificateSurveySchema } from "./learner.schema.js";

export async function getDashboard(req, res) {
  res.json(await learnerService.getDashboard(req.user.user_id));
}

export async function listMyTrainings(req, res) {
  res.json(await learnerService.listMyTrainings(req.user.user_id));
}

export async function getTrainingDetail(req, res) {
  const detail = await learnerService.getTrainingDetail(req.user.user_id, req.params.trainingId);
  res.json(detail);
}

export async function listCertificates(req, res) {
  res.json(await learnerService.listCertificates(req.user.user_id));
}

export async function getCertificate(req, res) {
  res.json(await learnerService.getCertificate(req.user.user_id, req.params.trainingRef));
}

export async function submitCertificateSurvey(req, res) {
  const responses = certificateSurveySchema.parse(req.body);
  const result = await learnerService.issueCertificateWithSurvey(
    req.user.user_id,
    req.params.trainingRef,
    responses
  );
  res.status(201).json(result);
}
