import { Router } from "express";
import * as ctrl from "./admin.controller.js";
import * as ticketCtrl from "../tickets/tickets.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

router.get(
  "/dashboard",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.getDashboard)
);

router.get(
  "/analytics",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.getAnalytics)
);

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

router.get(
  "/participants/:participantId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.getParticipantDetail)
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
  "/enrolments/:enrolmentId/complete",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.completeEnrolment)
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
  "/trainings/:trainingId/enrolments/complete-all",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.completeAllEnrolments)
);

router.patch(
  "/trainings/:trainingId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.updateTraining)
);

router.post(
  "/trainings/:trainingId/surveys",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.createSurvey)
);

router.get(
  "/trainings/:trainingId/surveys",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.listTrainingSurveys)
);

router.get(
  "/surveys/:surveyId/responses",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.listSurveyResponses)
);

// Support tickets — admin triage.
router.get(
  "/tickets",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ticketCtrl.adminList)
);

router.get(
  "/tickets/:ticketId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ticketCtrl.adminGet)
);

router.patch(
  "/tickets/:ticketId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ticketCtrl.adminUpdate)
);

router.post(
  "/tickets/:ticketId/messages",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ticketCtrl.adminReply)
);

export default router;
