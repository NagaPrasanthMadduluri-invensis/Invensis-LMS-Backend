import { Router } from "express";
import * as ctrl from "./cms.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// External CMS catalogue + schedules, proxied and normalized. Authenticated
// (any role) for now — tighten with requireRole once the consumer is decided.

// GET /api/cms/courses[?category=&search=&page=&per_page=&country=]
router.get("/courses", verifyToken, asyncHandler(ctrl.listCourses));

// GET /api/cms/courses/:courseSlug/schedules[?country=us]
router.get("/courses/:courseSlug/schedules", verifyToken, asyncHandler(ctrl.listSchedules));

export default router;
