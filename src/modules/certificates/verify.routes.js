import { Router } from "express";
import { verifyCertificate } from "./verify.service.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { publicVerifyLimiter } from "../../middleware/rate-limit.js";

/*
 * Public, unauthenticated. Mounted at /api/verify.
 *
 * Rate-limited because it is the one endpoint that answers questions about a
 * certificate without a token: without a limit it would be a way to grind
 * through candidate codes.
 */
const router = Router();

router.get(
  "/:code",
  publicVerifyLimiter,
  asyncHandler(async (req, res) => {
    const result = await verifyCertificate(req.params.code, req.query.name);
    // 200 either way: "not found" is a valid verification answer, not an error,
    // and a 404 would make the two cases awkward to tell apart from a bad URL.
    res.json(result);
  })
);

export default router;
