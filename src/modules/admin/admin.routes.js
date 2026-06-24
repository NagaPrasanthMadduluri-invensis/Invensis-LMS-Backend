import { Router } from "express";
import * as ctrl from "./admin.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

router.patch(
  "/trainings/:trainingId",
  verifyToken,
  requireRole("admin"),
  asyncHandler(ctrl.updateTraining)
);

export default router;
