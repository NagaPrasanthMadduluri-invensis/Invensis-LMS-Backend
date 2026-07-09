import { Router } from "express";
import * as ctrl from "./profile.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// The authenticated user's own profile — capability-based (any role), no gate
// beyond a valid token. Scoped entirely to req.user.
router.get("/profile", verifyToken, asyncHandler(ctrl.getProfile));
router.patch("/profile", verifyToken, asyncHandler(ctrl.updateProfile));
router.post("/profile/avatar-upload-url", verifyToken, asyncHandler(ctrl.avatarUploadUrl));

export default router;
