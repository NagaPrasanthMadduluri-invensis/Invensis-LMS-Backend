import { Router } from "express";
import * as ctrl from "./auth.controller.js";
import { verifyToken } from "../../middleware/verify-token.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

router.post("/login", authLimiter, asyncHandler(ctrl.login));
router.post("/refresh", authLimiter, asyncHandler(ctrl.refresh));
router.post("/logout", asyncHandler(ctrl.logout));
router.get("/me", verifyToken, asyncHandler(ctrl.me));
router.post("/forgot-password", authLimiter, asyncHandler(ctrl.forgotPassword));
router.post("/set-password", authLimiter, asyncHandler(ctrl.setPassword));

export default router;
