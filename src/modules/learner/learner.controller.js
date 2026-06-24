import * as learnerService from "./learner.service.js";

export async function getTrainingDetail(req, res) {
  const detail = await learnerService.getTrainingDetail(req.user.user_id, req.params.trainingId);
  res.json(detail);
}
