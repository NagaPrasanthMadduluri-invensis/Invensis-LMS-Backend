import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import authRoutes from "./modules/auth/auth.routes.js";
import { notFound, errorHandler } from "./middleware/error-handler.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(pinoHttp());

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.use("/api/auth", authRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`TMS/LMS API running on http://localhost:${env.PORT}`);
  console.log(`API base: http://localhost:${env.PORT}/api`);
});
