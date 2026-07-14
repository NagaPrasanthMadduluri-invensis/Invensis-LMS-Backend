import { eq } from "drizzle-orm";
import { hashPassword } from "../lib/password.js";
import { db, pool } from "../config/db.js";
import { users } from "./schema.js";
import { ingestOrder } from "../modules/orders/orders.service.js";
import { orderIntakeSchema } from "../modules/orders/orders.schema.js";

// Seeds demo data for one sponsor: two paid corporate orders, each ingested
// through the real order flow so the sponsor ends up with linked trainings,
// enrolments and orders. Idempotent — stable external ids, safe to re-run.
const SPONSOR = { name: "Sponsor User", email: "sponsor@invensis.test", role: "sponsor" };
const PASSWORD = "Password123!";

const ORDERS = [
  {
    order_id: "ORD-SPONSOR-SEED-1",
    order: { payment_status: "paid", purchase_type: "corporate" },
    course: { course_name: "PMP Certification Training", duration_hours: 32 },
    buyer: { name: SPONSOR.name, email: SPONSOR.email, company_name: "Invensis Learning" },
    learners: [
      { name: "Ravi Kumar", email: "ravi.kumar+seed@example.com", phone: "+91 90000 10001" },
      { name: "Meera Nair", email: "meera.nair+seed@example.com", phone: "+91 90000 10002" },
    ],
    schedule: {
      schedule_id: "SPONSOR-SEED-SCH-1",
      delivery_format: "live_virtual",
      batch_type: "weekday",
      timezone: "Asia/Kolkata",
      start_date: "2026-09-14",
      end_date: "2026-09-17",
      start_time: "09:00:00",
      end_time: "17:00:00",
      session_dates: ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
      duration_hours: 32,
    },
  },
  {
    order_id: "ORD-SPONSOR-SEED-2",
    order: { payment_status: "paid", purchase_type: "corporate" },
    course: { course_name: "AWS Solutions Architect", duration_hours: 24 },
    buyer: { name: SPONSOR.name, email: SPONSOR.email, company_name: "Invensis Learning" },
    learners: [
      { name: "Sara Ali", email: "sara.ali+seed@example.com", phone: "+91 90000 10003" },
    ],
    schedule: {
      schedule_id: "SPONSOR-SEED-SCH-2",
      delivery_format: "live_virtual",
      batch_type: "weekend",
      timezone: "Asia/Kolkata",
      start_date: "2026-10-10",
      end_date: "2026-10-18",
      start_time: "10:00:00",
      end_time: "16:00:00",
      session_dates: ["2026-10-10", "2026-10-11", "2026-10-17", "2026-10-18"],
      duration_hours: 24,
    },
  },
];

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await db
    .insert(users)
    .values({ ...SPONSOR, passwordHash })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash, role: SPONSOR.role, isActive: true } });
  console.log(`ensured sponsor ${SPONSOR.email} (password ${PASSWORD})`);

  for (const raw of ORDERS) {
    const res = await ingestOrder(null, orderIntakeSchema.parse(raw), "seed");
    console.log(
      `order ${res.order_id} -> ${res.training_code} | learners ${res.participants} | new enrolments ${res.new_enrolments} | enrolled_count ${res.enrolled_count}`
    );
  }

  const [sponsor] = await db.select({ id: users.id }).from(users).where(eq(users.email, SPONSOR.email)).limit(1);
  console.log(`\nsponsor_user_id = ${sponsor.id}`);
  await pool.end();
  console.log("done");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
