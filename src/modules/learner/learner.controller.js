import * as learnerService from "./learner.service.js";

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
