import { Router } from "express";
import * as ctrl from "./learner.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

router.get(
  "/training/:trainingId",
  verifyToken,
  requireRole("learner"),
  asyncHandler(ctrl.getTrainingDetail)
);

export default router;
