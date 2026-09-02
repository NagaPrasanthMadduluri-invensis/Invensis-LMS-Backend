import { Router } from "express";
import * as ctrl from "./courses.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

/* ─────────────────────────────────────────────────────────
   Enrolled-learner / trainer read — any authenticated user; the service
   enforces enrolment for learners/sponsors. Declared BEFORE the admin catalogue
   routes so "/my/..." isn't shadowed by "/:courseRef".
   ───────────────────────────────────────────────────────── */
router.get(
  "/my/trainings/:trainingRef/resources",
  verifyToken,
  asyncHandler(ctrl.myTrainingResources)
);

/* ─────────────────────────────────────────────────────────
   Admin — course catalogue (local mirror of the CMS)
   ───────────────────────────────────────────────────────── */
router.get("/", verifyToken, requireRole("admin"), asyncHandler(ctrl.listCourses));
router.post("/sync", verifyToken, requireRole("admin"), asyncHandler(ctrl.syncCourses));

/* ─────────────────────────────────────────────────────────
   Admin — supplementary resources (per training run).
   Declared BEFORE "/:courseRef" so "trainings" isn't read as a course ref.
   ───────────────────────────────────────────────────────── */
router.get(
  "/trainings/:trainingRef/resources",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.listTrainingResources)
);
router.post(
  "/trainings/:trainingRef/resources/upload-url",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.trainingResourceUploadUrl)
);
router.post(
  "/trainings/:trainingRef/resources",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.createTrainingResource)
);

/* ─────────────────────────────────────────────────────────
   Admin — shared resource ops (by resource id)
   ───────────────────────────────────────────────────────── */
router.patch(
  "/resources/:resourceId",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.updateResource)
);
router.delete(
  "/resources/:resourceId",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.deleteResource)
);

/* ─────────────────────────────────────────────────────────
   Admin — predefined resources (per course) + course detail.
   The "/:courseRef" wildcard routes come LAST.
   ───────────────────────────────────────────────────────── */
router.get(
  "/:courseRef/resources",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.listCourseResources)
);
router.post(
  "/:courseRef/resources/upload-url",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.courseResourceUploadUrl)
);
router.post(
  "/:courseRef/resources",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.createCourseResource)
);
router.get(
  "/:courseRef",
  verifyToken, requireRole("admin"), asyncHandler(ctrl.getCourse)
);

export default router;
