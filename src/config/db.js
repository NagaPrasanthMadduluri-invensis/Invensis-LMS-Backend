import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "./env.js";
import * as schema from "../db/schema.js";

const { Pool } = pg;

// SSL for managed databases (e.g. AWS RDS), controlled by DB_SSL:
//   disable    → no TLS (local dev)
//   require    → TLS with cert verification — provide the RDS CA bundle via
//                NODE_EXTRA_CA_CERTS=/path/to/rds-combined-ca-bundle.pem
//   no-verify  → TLS without cert verification (simplest for RDS)
function sslConfig() {
  switch (env.DB_SSL) {
    case "require":
      return { rejectUnauthorized: true };
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      return false;
  }
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslConfig(),
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

export const db = drizzle(pool, { schema });
