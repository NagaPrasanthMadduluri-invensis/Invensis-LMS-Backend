import { Router } from "express";
import * as ctrl from "./learner.controller.js";
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

export default router;
