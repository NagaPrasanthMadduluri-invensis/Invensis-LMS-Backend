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

router.post(
  "/trainers",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.onboardTrainer)
);

router.get(
  "/trainers/:trainerId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.getTrainerDetail)
);

router.patch(
  "/trainers/:trainerId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.updateTrainer)
);

router.get(
  "/participants",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.listParticipants)
);

router.patch(
  "/participants/:participantId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.updateParticipant)
);

router.patch(
  "/enrolments/:enrolmentId/cancel",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.cancelEnrolment)
);

router.patch(
  "/enrolments/:enrolmentId/transfer",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.transferEnrolment)
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
