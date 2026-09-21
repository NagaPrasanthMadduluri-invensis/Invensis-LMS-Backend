import { Router } from "express";
import * as ctrl from "./certificates.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

// Mounted at /api/admin/certificates. Admin-only: releasing a certificate is
// what makes it visible to a learner, so every route here is role-gated.
const router = Router();
router.use(verifyToken, requireRole("admin"));

// Overview across all trainings.
router.get("/", asyncHandler(ctrl.listAll));

// Completed trainings, for the picker.
router.get("/trainings", asyncHandler(ctrl.listTrainings));

// One training: header stats + every learner's certificate line.
router.get("/trainings/:trainingRef", asyncHandler(ctrl.trainingDetail));

// PDUs + PMI claim code for the training. Must be set before generating.
router.put("/trainings/:trainingRef/pdus", asyncHandler(ctrl.setPdus));

// Create missing certificate rows (does NOT release them).
router.post("/trainings/:trainingRef/generate", asyncHandler(ctrl.generate));

// Make them visible to learners. Body may carry `enrolment_ids` for a subset.
router.post("/trainings/:trainingRef/release", asyncHandler(ctrl.release));

// Per-certificate actions.
router.post("/:certificateId/revoke", asyncHandler(ctrl.revoke));
router.patch("/:certificateId", asyncHandler(ctrl.update));

export default router;
