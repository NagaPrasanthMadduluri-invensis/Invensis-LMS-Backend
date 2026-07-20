import { and, eq } from "drizzle-orm";
import { db, pool } from "../config/db.js";
import { trainingIds, surveys } from "./schema.js";

// Canonical post-training feedback survey (mirrors the frontend constant). The
// `questions` array is stored as-is (flexible, frontend-owned shape); `answers`
// submitted by learners are keyed by these ids.
const POST_TRAINING_SURVEY_TITLE = "Post-Training Feedback";
const POST_TRAINING_QUESTIONS = [
  { id: "overall_rating", type: "rating", label: "Overall experience", hint: "How was the training overall?", required: true },
  { id: "trainer_rating", type: "rating", label: "Trainer", hint: "Knowledge, clarity, engagement", required: true },
  { id: "content_rating", type: "rating", label: "Course content", hint: "Material, pace, relevance", required: true },
  { id: "would_recommend", type: "boolean", label: "Would you recommend it?", required: true },
  { id: "comments", type: "text", label: "Comments", required: false },
];

// Author the post-training survey for every non-cancelled training that lacks
// one. Idempotent — safe to re-run.
async function seed() {
  const trainings = await db
    .select({ id: trainingIds.id, code: trainingIds.code, status: trainingIds.status })
    .from(trainingIds);

  let created = 0;
  let skipped = 0;
  for (const t of trainings) {
    if (t.status === "cancelled") {
      skipped += 1;
      continue;
    }
    const [existing] = await db
      .select({ id: surveys.id })
      .from(surveys)
      .where(and(eq(surveys.trainingId, t.id), eq(surveys.type, "post_training")))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }
    await db.insert(surveys).values({
      trainingId: t.id,
      type: "post_training",
      title: POST_TRAINING_SURVEY_TITLE,
      questions: POST_TRAINING_QUESTIONS,
    });
    created += 1;
    console.log(`+ post_training survey → ${t.code}`);
  }

  console.log(`\ndone: ${created} created, ${skipped} skipped (already present or cancelled)`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
