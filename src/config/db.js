import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "./env.js";
import * as schema from "../db/schema.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

export const db = drizzle(pool, { schema });
