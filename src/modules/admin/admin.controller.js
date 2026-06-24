import { updateTrainingSchema } from "./admin.schema.js";
import * as adminService from "./admin.service.js";

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
