import { Router } from "express";
import * as ctrl from "./webinars.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { requireRole } from "../../middleware/require-role.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// Banner — any authenticated user (learner or sponsor). Declared before the
// admin list so "current" isn't read as an :id.
router.get("/current", verifyToken, asyncHandler(ctrl.getCurrent));

// Admin management.
router.get("/", verifyToken, requireRole("admin"), asyncHandler(ctrl.list));
router.post("/", verifyToken, requireRole("admin"), asyncHandler(ctrl.create));
router.patch("/:id", verifyToken, requireRole("admin"), asyncHandler(ctrl.update));
router.delete("/:id", verifyToken, requireRole("admin"), asyncHandler(ctrl.remove));

export default router;
