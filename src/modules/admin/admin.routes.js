import { Router } from "express";
import * as ctrl from "./admin.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

router.get(
  "/trainings",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.listTrainings)
);

router.get(
  "/trainers",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.listTrainers)
);

router.get(
  "/trainings/:trainingId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.getTrainingDetail)
);

router.post(
  "/trainings/:trainingId/participants",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.addParticipant)
);

router.patch(
  "/trainings/:trainingId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.updateTraining)
);

export default router;
