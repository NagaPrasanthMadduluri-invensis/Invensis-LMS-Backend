import { Router } from "express";
import * as ctrl from "./orders.controller.js";
import { verifyHmac } from "../../middleware/verify-hmac.js";
import { asyncHandler } from "../../lib/async-handler.js";

const router = Router();

// xCRM pushes a confirmed (order.paid) order, authenticated by HMAC signature.
router.post("/", verifyHmac, asyncHandler(ctrl.intake));

export default router;
