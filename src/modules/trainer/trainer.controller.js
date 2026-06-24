import { updateTopicsSchema } from "./trainer.schema.js";
import * as trainerService from "./trainer.service.js";

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
