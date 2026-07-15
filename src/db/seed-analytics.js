import { eq, like } from "drizzle-orm";
import { db, pool } from "../config/db.js";
import {
  users,
  schedules,
  trainingIds,
  trainingSessions,
  trainers,
  trainerAssignments,
  participants,
  enrolments,
} from "./schema.js";

/*
 * Additive demo data for the admin ANALYTICS dashboard. Creates a spread of
 * trainings across delivery modes, buckets, lifecycle statuses and dates
 * (~8 months in the past to ~15 months ahead), several trainers, a pool of
 * participants and many enrolments with varied statuses/dates — so every chart
 * on the analytics dashboard has something meaningful to show.
 *
 * Idempotent & non-destructive: everything it creates is namespaced with a
 * "DEMO" marker (training codes TRN-DEMO-####, emails @analytics.test). If the
 * demo trainings already exist it exits without touching anything. Nothing that
 * "npm run db:seed" / "db:seed:training" created is modified or deleted.
 *
 * Run:  npm run db:seed:analytics     (re-run safe; --reset to rebuild)
 */

const CODE_PREFIX = "TRN-DEMO-";
const EMAIL_DOMAIN = "@analytics.test";
const START_TIME = "09:00:00";
const END_TIME = "17:00:00";

const RESET = process.argv.includes("--reset");

/* ── deterministic PRNG so re-seeds produce the same graph ── */
let _seed = 20260714;
function rand() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));

function addMonths(base, n) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + n);
  return d;
}
function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}
const fmtDate = (d) => d.toISOString().slice(0, 10);

const COURSES = [
  { title: "PMP Certification Training", bucket: "direct_online", mode: "virtual", hours: 32 },
  { title: "Certified ScrumMaster (CSM)", bucket: "direct_online", mode: "virtual", hours: 16 },
  { title: "ITIL 4 Foundation", bucket: "direct_online", mode: "hybrid", hours: 24 },
  { title: "Six Sigma Green Belt", bucket: "corporate", mode: "in_person", hours: 40 },
  { title: "AWS Solutions Architect", bucket: "direct_online", mode: "virtual", hours: 30 },
  { title: "Lean Management Masterclass", bucket: "corporate", mode: "in_person", hours: 24 },
  { title: "PRINCE2 Practitioner", bucket: "direct_online", mode: "hybrid", hours: 21 },
  { title: "Executive Leadership Coaching", bucket: "one_to_one_coaching", mode: "one_to_one", hours: 12 },
  { title: "Data Analytics Bootcamp", bucket: "corporate", mode: "virtual", hours: 45 },
  { title: "DevOps Foundation", bucket: "direct_online", mode: "virtual", hours: 20 },
  { title: "Agile Coaching Intensive", bucket: "one_to_one_coaching", mode: "one_to_one", hours: 10 },
  { title: "Cybersecurity Essentials", bucket: "corporate", mode: "hybrid", hours: 35 },
];

const TRAINERS = [
  { name: "Priya Nair", bio: "PMP & PRINCE2 lead trainer", experience: "12 years", certs: 3, specializations: ["PMP", "PRINCE2"], city: "Bengaluru", country: "India", isRemote: true },
  { name: "Arjun Mehta", bio: "Agile & Scrum coach", experience: "9 years", certs: 2, specializations: ["Scrum (CSM)", "SAFe Agile", "Agile Coaching"], city: "Mumbai", country: "India", isRemote: true },
  { name: "Sarah Collins", bio: "Cloud & DevOps specialist", experience: "8 years", certs: 4, specializations: ["AWS", "Azure", "DevOps"], city: "London", country: "United Kingdom", isRemote: true },
  { name: "David Okafor", bio: "Lean Six Sigma master black belt", experience: "15 years", certs: 2, specializations: ["Six Sigma", "Business Analysis"], city: "Dubai", country: "UAE", isRemote: false },
  { name: "Meera Krishnan", bio: "Data & analytics instructor", experience: "7 years", certs: 1, specializations: ["Business Analysis", "PMI-ACP"], city: null, country: null, isRemote: true },
  { name: "Thomas Reed", bio: "Leadership & executive coach", experience: "11 years", certs: 0, specializations: ["Leadership & Management"], city: "New York", country: "USA", isRemote: false },
];

const FIRST = ["Rahul", "Anita", "James", "Sofia", "Wei", "Fatima", "Carlos", "Nadia", "Liam", "Grace", "Omar", "Elena", "Kenji", "Aisha", "Noah", "Divya", "Lucas", "Mei", "Ibrahim", "Chloe"];
const LAST = ["Sharma", "Patel", "Wong", "Garcia", "Khan", "Silva", "Muller", "Rossi", "Nakamura", "Ali", "Brown", "Kumar", "Adeyemi", "Ivanov", "Chen", "Dubois", "Costa", "Yadav", "Kim", "Haddad"];

// In-person / hybrid trainings get a physical venue; virtual / 1:1 stay online.
const LOCATIONS = [
  { city: "Bengaluru", country: "India" },
  { city: "Mumbai", country: "India" },
  { city: "London", country: "United Kingdom" },
  { city: "New York", country: "USA" },
  { city: "Dubai", country: "UAE" },
  { city: "Singapore", country: "Singapore" },
];

// Daily session windows (hours per day) the schedule can run.
const DAILY_HOURS = [2, 4, 6, 8];

// Learner geography — sourced from xCRM customer.billing. Present for every
// order (incl. live_virtual), so geo analytics keys off the learner, not the venue.
const GEO = [
  { country: "United States", cities: ["Austin", "New York", "Chicago", "San Jose"] },
  { country: "United Kingdom", cities: ["London", "Manchester", "Bristol"] },
  { country: "India", cities: ["Bengaluru", "Mumbai", "Hyderabad", "Pune"] },
  { country: "United Arab Emirates", cities: ["Dubai", "Abu Dhabi"] },
  { country: "Singapore", cities: ["Singapore"] },
  { country: "Australia", cities: ["Sydney", "Melbourne"] },
  { country: "Germany", cities: ["Berlin", "Munich"] },
  { country: "Canada", cities: ["Toronto", "Vancouver"] },
];

// Package / pricing tiers (xCRM package.name) with price multipliers + weights.
const TIERS = [
  { name: "Standard", mult: 1.0 },
  { name: "Silver", mult: 1.25 },
  { name: "Gold", mult: 1.6 },
  { name: "Platinum", mult: 2.1 },
];
function pickTier() {
  const r = rand();
  if (r < 0.35) return TIERS[0];
  if (r < 0.65) return TIERS[1];
  if (r < 0.9) return TIERS[2];
  return TIERS[3];
}

// Learner-profile dimensions (mirror user_profiles / xCRM customer fields).
const COMPANIES = ["Acme Corp", "Globex", "Initech", "Umbrella Group", "Stark Industries", "Wayne Enterprises", "Hooli", "Vandelay Industries", "Massive Dynamic", "Cyberdyne", "Pied Piper", "Soylent Corp"];
const DEPARTMENTS = ["Information Technology", "Operations", "Project Management", "Engineering", "Finance", "Human Resources", "Marketing", "Sales", "Quality Assurance"];
const JOB_TITLES = ["Project Manager", "Business Analyst", "Software Engineer", "Scrum Master", "Product Owner", "QA Engineer", "Team Lead", "IT Manager", "Operations Manager", "Consultant", "Program Director", "DevOps Engineer"];

async function userByEmail(email) {
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return u ?? null;
}

async function resetDemo() {
  // Delete only the DEMO-namespaced graph, children first.
  const demoTrainings = await db
    .select({ id: trainingIds.id, scheduleId: trainingIds.scheduleId })
    .from(trainingIds)
    .where(like(trainingIds.code, `${CODE_PREFIX}%`));
  for (const t of demoTrainings) {
    await db.delete(enrolments).where(eq(enrolments.trainingId, t.id));
    await db.delete(trainerAssignments).where(eq(trainerAssignments.trainingId, t.id));
    await db.delete(trainingSessions).where(eq(trainingSessions.trainingId, t.id));
    await db.delete(trainingIds).where(eq(trainingIds.id, t.id));
    if (t.scheduleId) await db.delete(schedules).where(eq(schedules.id, t.scheduleId));
  }
  // Demo participants (no linked user accounts).
  const demoParts = await db
    .select({ id: participants.id })
    .from(participants)
    .where(like(participants.email, `%${EMAIL_DOMAIN}`));
  for (const p of demoParts) await db.delete(participants).where(eq(participants.id, p.id));

  // Demo trainer profiles must go before their user accounts (FK), then the
  // demo user accounts themselves (@analytics.test).
  const demoUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${EMAIL_DOMAIN}`));
  for (const u of demoUsers) await db.delete(trainers).where(eq(trainers.userId, u.id));
  await db.delete(users).where(like(users.email, `%${EMAIL_DOMAIN}`));
  console.log(`Reset: removed ${demoTrainings.length} demo trainings, ${demoParts.length} participants, ${demoUsers.length} trainer accounts.`);
}

async function seed() {
  const admin = await userByEmail("admin@invensis.test");
  if (!admin) {
    console.error('Base admin not found — run "npm run db:seed" first.');
    await pool.end();
    return;
  }

  if (RESET) await resetDemo();

  const existing = await db
    .select({ id: trainingIds.id })
    .from(trainingIds)
    .where(like(trainingIds.code, `${CODE_PREFIX}%`))
    .limit(1);
  if (existing.length > 0) {
    console.log(`Demo analytics data already present (${CODE_PREFIX}…). Use "--reset" to rebuild. Skipping.`);
    await pool.end();
    return;
  }

  const today = new Date();

  /* ── Trainers ── */
  const trainerRows = [];
  for (let i = 0; i < TRAINERS.length; i++) {
    const t = TRAINERS[i];
    const email = `trainer${i + 1}${EMAIL_DOMAIN}`;
    let user = await userByEmail(email);
    if (!user) {
      [user] = await db.insert(users).values({ email, name: t.name, role: "trainer" }).returning();
    }
    const [trainer] = await db
      .insert(trainers)
      .values({
        userId: user.id,
        bio: t.bio,
        experience: t.experience,
        rate: String(randInt(80, 220)),
        certificates: Array.from({ length: t.certs }, (_, k) => ({
          title: `Professional Certificate ${k + 1}`,
          issued_by: "Invensis Learning",
        })),
        specializations: t.specializations ?? [],
        city: t.city ?? null,
        country: t.country ?? null,
        isRemote: t.isRemote ?? false,
        isActive: i !== TRAINERS.length - 1 ? true : rand() > 0.5, // last one maybe inactive
      })
      .returning();
    trainerRows.push(trainer);
  }

  /* ── Participant pool (created dates spread across the past year) ── */
  const pool_ = [];
  for (let i = 0; i < 44; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const name = `${first} ${last}`;
    const email = `learner.${first}.${last}.${i}${EMAIL_DOMAIN}`.toLowerCase();
    const createdAt = addDays(addMonths(today, -randInt(0, 11)), -randInt(0, 27));
    const geo = pick(GEO);
    const [p] = await db
      .insert(participants)
      .values({
        name,
        email,
        phone: `+1-555-${String(randInt(1000, 9999))}`,
        jobTitle: pick(JOB_TITLES),
        company: pick(COMPANIES),
        department: pick(DEPARTMENTS),
        experienceYears: randInt(0, 18),
        city: pick(geo.cities),
        country: geo.country,
        createdAt,
      })
      .returning();
    pool_.push({ id: p.id, createdAt });
  }

  /* ── Trainings across time / modes / buckets / statuses ── */
  const NUM_TRAININGS = 26;
  let created = 0;
  let totalEnrol = 0;

  for (let i = 0; i < NUM_TRAININGS; i++) {
    const course = COURSES[i % COURSES.length];
    const monthOffset = -8 + i; // -8 .. +17
    const start = addDays(addMonths(today, monthOffset), randInt(0, 20));
    const durationDays = randInt(1, 4);
    const sessionDates = Array.from({ length: durationDays }, (_, k) => fmtDate(addDays(start, k)));
    const end = new Date(`${sessionDates[sessionDates.length - 1]}T00:00:00`);

    // Status derived from where the training sits in time.
    let status;
    const daysFromNow = Math.round((start - today) / 86400000);
    if (daysFromNow < -7) status = i % 8 === 0 ? "cancelled" : "completed";
    else if (daysFromNow <= 3) status = "ongoing";
    else if (daysFromNow <= 60) status = "active";
    else status = i % 3 === 0 ? "active" : "pending";

    const capacity = randInt(12, 40);
    const minSeats = randInt(3, 6);
    const basePrice = 700 + course.hours * 18; // per-seat list price before tier

    // Daily window + physical venue (in-person / hybrid only).
    const dailyHours = pick(DAILY_HOURS);
    const endTimeStr = `${String(9 + dailyHours).padStart(2, "0")}:00:00`;
    const isInPerson = course.mode === "in_person" || course.mode === "hybrid";
    const loc = isInPerson ? pick(LOCATIONS) : null;

    const [schedule] = await db
      .insert(schedules)
      .values({
        title: course.title,
        bucket: course.bucket,
        deliveryMode: course.mode,
        batchType: pick(["weekday", "weekend", "combined"]),
        durationHours: dailyHours * durationDays,
        capacity,
        minSeats,
        startDate: sessionDates[0],
        endDate: sessionDates[sessionDates.length - 1],
        startTime: START_TIME,
        endTime: endTimeStr,
        sessionDates,
        venue: loc ? { city: loc.city, country: loc.country, address: `${loc.city} Learning Center` } : null,
        timezone: "Asia/Kolkata",
        createdBy: admin.id,
      })
      .returning();

    const code = `${CODE_PREFIX}${String(1000 + i)}`;
    const [training] = await db
      .insert(trainingIds)
      .values({
        scheduleId: schedule.id,
        code,
        title: course.title,
        bucket: course.bucket,
        deliveryMode: course.mode,
        status,
        capacity,
        minSeats,
        meetingUrl: course.mode === "in_person" ? null : "https://zoom.us/j/demo",
        meetingPlatform: course.mode === "in_person" ? null : "zoom",
        meetingReleased: status === "ongoing" || status === "completed",
        createdBy: admin.id,
      })
      .returning();

    // Day-wise sessions; past/ongoing days completed, future days scheduled.
    await db.insert(trainingSessions).values(
      sessionDates.map((d, k) => {
        const sStart = new Date(`${d}T${START_TIME}+05:30`);
        let sStatus = "scheduled";
        if (status === "completed" || status === "cancelled") sStatus = status === "cancelled" ? "cancelled" : "completed";
        else if (status === "ongoing") sStatus = sStart < today ? "completed" : "scheduled";
        return {
          trainingId: training.id,
          dayNumber: k + 1,
          plannedTopics: `Day ${k + 1}: core concepts and hands-on practice`,
          startTime: sStart,
          endTime: new Date(`${d}T${endTimeStr}+05:30`),
          status: sStatus,
        };
      })
    );

    // Assign a trainer (cancelled trainings sometimes left unassigned).
    if (!(status === "cancelled" && rand() > 0.5)) {
      const trainer = trainerRows[i % trainerRows.length];
      await db.insert(trainerAssignments).values({
        trainingId: training.id,
        trainerId: trainer.id,
        assignedBy: admin.id,
        assignedAt: addDays(start, -randInt(20, 45)),
      });
    }

    // Enrolments — pick a unique subset of the participant pool.
    const target = Math.min(capacity, randInt(minSeats, capacity));
    const chosen = new Set();
    while (chosen.size < target) chosen.add(Math.floor(rand() * pool_.length));

    let confirmedCount = 0;
    for (const idx of chosen) {
      const p = pool_[idx];
      // Enrol shortly before the training starts (bounded to not precede signup).
      let enrolledAt = addDays(start, -randInt(3, 40));
      if (enrolledAt < p.createdAt) enrolledAt = p.createdAt;

      let eStatus;
      if (status === "completed") eStatus = rand() > 0.15 ? "completed" : pick(["cancelled", "transferred"]);
      else if (status === "cancelled") eStatus = "cancelled";
      else if (status === "ongoing") eStatus = rand() > 0.1 ? "confirmed" : "cancelled";
      else eStatus = rand() > 0.08 ? "confirmed" : "cancelled";

      // Attendance is only meaningful once a training has completed. Among its
      // real participants (completed/confirmed enrolments): mostly present, some
      // partial, a few no-shows. Everyone else stays 'not_marked'.
      let attendanceStatus = "not_marked";
      if (status === "completed" && (eStatus === "completed" || eStatus === "confirmed")) {
        const r = rand();
        attendanceStatus = r < 0.7 ? "present" : r < 0.88 ? "partial" : "absent";
      }

      // Revenue attributes (per xCRM order + package).
      const tier = pickTier();
      const amount = String(Math.round(basePrice * tier.mult));

      // Sponsorship (xCRM order.purchase_type): corporate offerings are always
      // corporate-sponsored; coaching is mostly self; direct-online is a mix.
      let sponsorship;
      if (course.bucket === "corporate") sponsorship = "corporate";
      else if (course.bucket === "one_to_one_coaching") sponsorship = rand() < 0.8 ? "self" : "corporate";
      else sponsorship = rand() < 0.65 ? "self" : "corporate";

      await db
        .insert(enrolments)
        .values({
          trainingId: training.id,
          participantId: p.id,
          status: eStatus,
          attendanceStatus,
          amount,
          currency: "USD",
          pricingTier: tier.name,
          sponsorship,
          enrolledAt,
        })
        .onConflictDoNothing();
      if (eStatus === "confirmed" || eStatus === "completed") confirmedCount += 1;
      totalEnrol += 1;
    }

    await db.update(trainingIds).set({ enrolledCount: confirmedCount }).where(eq(trainingIds.id, training.id));
    created += 1;
  }

  /* ── Near-term trainings that need admin action (populate the dashboard
     Action Center): awaiting a trainer, ready to release the meeting link,
     and under-enrolled starting soon. ── */
  const NEAR_TERM = [
    { title: "PMP Certification Training", mode: "virtual", bucket: "direct_online", days: 12, trainer: false, fill: "ok" },   // awaiting trainer (+ releasable)
    { title: "AWS Solutions Architect", mode: "virtual", bucket: "direct_online", days: 8, trainer: true, fill: "ok" },        // releasable
    { title: "ITIL 4 Foundation", mode: "hybrid", bucket: "corporate", days: 5, trainer: true, fill: "ok" },                   // releasable
    { title: "Six Sigma Green Belt", mode: "in_person", bucket: "corporate", days: 15, trainer: true, fill: "low" },           // under-enrolled
    { title: "DevOps Foundation", mode: "virtual", bucket: "direct_online", days: 18, trainer: false, fill: "low" },           // under-enrolled + awaiting
  ];
  let ni = 0;
  for (const nt of NEAR_TERM) {
    const start = addDays(today, nt.days);
    const sessionDates = [fmtDate(start), fmtDate(addDays(start, 1))];
    const capacity = 25;
    const minSeats = 6;
    const [schedule] = await db
      .insert(schedules)
      .values({
        title: nt.title, bucket: nt.bucket, deliveryMode: nt.mode, batchType: "weekday",
        durationHours: 12, capacity, minSeats,
        startDate: sessionDates[0], endDate: sessionDates[1],
        startTime: START_TIME, endTime: "15:00:00", sessionDates,
        venue: nt.mode === "virtual" ? null : { city: "Bengaluru", country: "India", address: "Bengaluru Learning Center" },
        timezone: "Asia/Kolkata", createdBy: admin.id,
      })
      .returning();
    const [training] = await db
      .insert(trainingIds)
      .values({
        scheduleId: schedule.id, code: `${CODE_PREFIX}${String(2000 + ni)}`, title: nt.title,
        bucket: nt.bucket, deliveryMode: nt.mode, status: "active", capacity, minSeats,
        meetingUrl: nt.mode === "in_person" ? null : "https://zoom.us/j/demo",
        meetingPlatform: nt.mode === "in_person" ? null : "zoom",
        meetingReleased: false, // never released → the releasable ones show up as actions
        createdBy: admin.id,
      })
      .returning();
    await db.insert(trainingSessions).values(
      sessionDates.map((d, k) => ({
        trainingId: training.id, dayNumber: k + 1, plannedTopics: `Day ${k + 1}`,
        startTime: new Date(`${d}T${START_TIME}+05:30`), endTime: new Date(`${d}T15:00:00+05:30`),
        status: "scheduled",
      }))
    );
    if (nt.trainer) {
      await db.insert(trainerAssignments).values({
        trainingId: training.id, trainerId: trainerRows[ni % trainerRows.length].id,
        assignedBy: admin.id, assignedAt: addDays(start, -20),
      });
    }
    const target = nt.fill === "ok" ? 12 : 2; // 'low' stays below minSeats (6)
    const chosen = new Set();
    while (chosen.size < target) chosen.add(Math.floor(rand() * pool_.length));
    let cc = 0;
    for (const idx of chosen) {
      const p = pool_[idx];
      const tier = pickTier();
      const sponsorship = nt.bucket === "corporate" ? "corporate" : rand() < 0.6 ? "self" : "corporate";
      await db
        .insert(enrolments)
        .values({
          trainingId: training.id, participantId: p.id, status: "confirmed",
          attendanceStatus: "not_marked", amount: String(Math.round((700 + 12 * 18) * tier.mult)),
          currency: "USD", pricingTier: tier.name, sponsorship, enrolledAt: addDays(start, -10),
        })
        .onConflictDoNothing();
      cc += 1;
      totalEnrol += 1;
    }
    await db.update(trainingIds).set({ enrolledCount: cc }).where(eq(trainingIds.id, training.id));
    created += 1;
    ni += 1;
  }

  console.log(
    `Seeded ${created} demo trainings, ${trainerRows.length} trainers, ${pool_.length} participants, ~${totalEnrol} enrolments.`
  );
  console.log("Open the admin dashboard to see the analytics come alive.");
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
