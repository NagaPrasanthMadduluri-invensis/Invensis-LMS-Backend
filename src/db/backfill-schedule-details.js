/**
 * One-shot backfill: populate schedules.hours_per_day (and any missing timezone)
 * from the raw order payloads we already stored (orders.payload). Needed once,
 * after adding the hours_per_day column, so trainings confirmed BEFORE the change
 * show "Hours / Day" (and timezone) without re-ingesting.
 *
 * Safe to re-run: only touches rows where the target column is still NULL.
 *
 *   node src/db/backfill-schedule-details.js
 */
import { sql } from "drizzle-orm";
import { db } from "../config/db.js";

const hoursRes = await db.execute(sql`
  UPDATE schedules s
  SET hours_per_day = NULLIF(o.payload->'schedule'->>'hours_per_day', '')::int,
      updated_at = now()
  FROM orders o
  WHERE o.schedule_id = s.id
    AND s.hours_per_day IS NULL
    AND NULLIF(o.payload->'schedule'->>'hours_per_day', '') IS NOT NULL
`);

const tzRes = await db.execute(sql`
  UPDATE schedules s
  SET timezone = COALESCE(
        NULLIF(o.payload->'schedule'->>'timezone', ''),
        NULLIF(o.payload->'schedule'->>'timezone_code', '')
      ),
      updated_at = now()
  FROM orders o
  WHERE o.schedule_id = s.id
    AND s.timezone IS NULL
    AND COALESCE(
          NULLIF(o.payload->'schedule'->>'timezone', ''),
          NULLIF(o.payload->'schedule'->>'timezone_code', '')
        ) IS NOT NULL
`);

console.log(`hours_per_day backfilled: ${hoursRes.rowCount ?? 0} schedule(s)`);
console.log(`timezone backfilled:      ${tzRes.rowCount ?? 0} schedule(s)`);
process.exit(0);
