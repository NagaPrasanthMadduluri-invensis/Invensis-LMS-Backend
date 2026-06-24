import { Router } from "express";
import * as ctrl from "./orders.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// xCRM pushes a confirmed (order.paid) order; admin-authenticated.
router.post("/", verifyToken, requireRole("admin"), asyncHandler(ctrl.intake));

export default router;
