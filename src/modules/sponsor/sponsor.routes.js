import { Router } from "express";
import * as ctrl from "./sponsor.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// Scoped to the caller's own sponsored orders — capability-based, no role gate
// (a learner-role user who also bought seats still sees their sponsor data).
router.get("/dashboard", verifyToken, asyncHandler(ctrl.getDashboard));
router.get("/learners", verifyToken, asyncHandler(ctrl.listSponsoredLearners));
router.get("/invoices", verifyToken, asyncHandler(ctrl.listInvoices));

export default router;
