import { Router } from "express";
import * as ctrl from "./trainer.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

router.get(
  "/trainings",
  verifyToken,
  requireRole("trainer"),
  asyncHandler(ctrl.listMyTrainings)
);

router.get(
  "/trainings/:trainingRef",
  verifyToken,
  requireRole("trainer"),
  asyncHandler(ctrl.getTrainingDetail)
);

router.patch(
  "/sessions/:sessionId/topics",
  verifyToken,
  requireRole("trainer"),
  asyncHandler(ctrl.updateSessionTopics)
);

export default router;
