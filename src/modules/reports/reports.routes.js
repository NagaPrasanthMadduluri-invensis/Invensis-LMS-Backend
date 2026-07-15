import { Router } from "express";
import * as ctrl from "./reports.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// Sales/revenue snapshot for the admin Reports page.
router.get("/sales", verifyToken, requireRole("admin"), asyncHandler(ctrl.getSalesReport));

// Raw row-level records (one row per enrolment) for the raw-data export.
router.get("/sales/records", verifyToken, requireRole("admin"), asyncHandler(ctrl.getSalesRecords));

export default router;
