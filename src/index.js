import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import authRoutes from "./modules/auth/auth.routes.js";
import learnerRoutes from "./modules/learner/learner.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import trainerRoutes from "./modules/trainer/trainer.routes.js";
import ordersRoutes from "./modules/orders/orders.routes.js";
import { notFound, errorHandler } from "./middleware/error-handler.js";

const app = express();

// Behind an ALB / reverse proxy: trust the first hop so the real client IP
// (used by express-rate-limit) and protocol detection are correct.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
// Capture the raw body so HMAC signatures can be verified over exact bytes.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(pinoHttp());

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.use("/api/auth", authRoutes);
app.use("/api/learner", learnerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/trainer", trainerRoutes);
app.use("/api/orders", ordersRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`TMS/LMS API running on http://localhost:${env.PORT}`);
  console.log(`API base: http://localhost:${env.PORT}/api`);
});
