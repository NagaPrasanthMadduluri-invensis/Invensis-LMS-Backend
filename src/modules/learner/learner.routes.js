import { Router } from "express";
import * as ctrl from "./learner.controller.js";
import * as ticketCtrl from "../tickets/tickets.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// Learner dashboard — scoped to the caller's own enrolments (capability-based),
// so no role gate: any authenticated user gets their journey + upcoming cohorts.
router.get(
  "/dashboard",
  verifyToken,
  asyncHandler(ctrl.getDashboard)
);

// "My Courses" — scoped to the caller's own enrolments, so no role gate
// (capability-based: a sponsor-role user who also attends still sees their courses).
router.get(
  "/trainings",
  verifyToken,
  asyncHandler(ctrl.listMyTrainings)
);

router.get(
  "/training/:trainingId",
  verifyToken,
  requireRole("learner"),
  asyncHandler(ctrl.getTrainingDetail)
);

// Certificates — scoped to the caller's own completed enrolments
// (capability-based, no role gate, like /dashboard and /trainings).
router.get(
  "/certificates",
  verifyToken,
  asyncHandler(ctrl.listCertificates)
);

// Submit the post-training feedback survey → issues (unlocks) the certificate.
router.post(
  "/certificates/:trainingRef/survey",
  verifyToken,
  asyncHandler(ctrl.submitCertificateSurvey)
);

// Printable certificate data — 403 until the survey has been submitted.
router.get(
  "/certificates/:trainingRef",
  verifyToken,
  asyncHandler(ctrl.getCertificate)
);

// Support tickets — scoped to the caller's own participant profile
// (capability-based, no role gate, like /dashboard and /trainings).
router.get("/tickets", verifyToken, asyncHandler(ticketCtrl.learnerList));
router.post("/tickets", verifyToken, asyncHandler(ticketCtrl.learnerCreate));
router.get("/tickets/:ticketId", verifyToken, asyncHandler(ticketCtrl.learnerGet));

export default router;
