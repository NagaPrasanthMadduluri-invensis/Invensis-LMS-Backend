import rateLimit from "express-rate-limit";

// Applied to /api/auth/* per architecture doc §9.3
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
});

/**
 * Public certificate verification.
 *
 * The only unauthenticated endpoint that answers questions about a certificate,
 * so it is the only one someone could grind through candidate codes with.
 * Deliberately looser than the auth limiter: a QR scan at the end of a training
 * day can bring a whole cohort through one office IP within a minute, and
 * blocking genuine holders is worse than the guessing this slows down.
 */
export const publicVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many verification attempts. Please try again in a minute." },
});
