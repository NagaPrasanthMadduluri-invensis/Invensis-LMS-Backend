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

// Printable data for one certificate (the admin download path). Available once
// generated, whether or not released; does not affect the learner download_count.
router.get("/:certificateId/printable", asyncHandler(ctrl.printable));

// Per-certificate actions.
router.post("/:certificateId/revoke", asyncHandler(ctrl.revoke));
router.patch("/:certificateId", asyncHandler(ctrl.update));

export default router;
