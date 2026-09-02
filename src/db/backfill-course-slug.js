/**
 * One-shot backfill: populate training_ids.course_slug (+ course_type,
 * certification_included) for trainings confirmed BEFORE those columns existed,
 * so the course-resources feature can link a training to its course's predefined
 * resources.
 *
 * Fully data-driven — NO hardcoded title→slug map. Resolution order per training
 * (first hit wins), all sourced from real data:
 *   1. The training's order payload  →  payload.course.slug   (authoritative)
 *   2. Exact (case-insensitive) match of the training title to a synced course name
 *   3. Normalized-unique match (drop punctuation + generic words like
 *      "training"/"certification"/"course") to a single synced course
 * A training that matches nothing — or matches ambiguously — is left untouched
 * (course_slug stays NULL) and reported, rather than guessed at.
 *
 * course_type / certification_included are copied from the matched `courses` row,
 * mirroring what order ingest stores (see orders.service.js → resolveCourseFacts).
 *
 * Requires the CMS catalogue to be synced first (admin "Sync from CMS", or it
 * runs with whatever `courses` rows exist). Safe to re-run: only fills rows where
 * course_slug IS NULL.
 *
 *   node src/db/backfill-course-slug.js
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../config/db.js";
import { trainingIds, orders, courses } from "./schema.js";

// Normalize a course/training name for fuzzy comparison: lowercase, strip
// punctuation, and drop generic packaging words that trainings tack on but the
// CMS course name usually omits (and vice-versa).
const GENERIC = /\b(training|certification|certificate|course|program|programme|masterclass|bootcamp|intensive|essentials|fundamentals)\b/g;
function normalize(name = "") {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(GENERIC, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const catalogue = await db
    .select({
      slug: courses.slug,
      name: courses.name,
      courseType: courses.courseType,
      certificationIncluded: courses.certificationIncluded,
    })
    .from(courses);

  if (catalogue.length === 0) {
    console.error("No courses in the local catalogue. Run the CMS sync first (admin → Course Catalog → Sync from CMS).");
    process.exit(1);
  }

  // Lookup structures.
  const byExact = new Map(); // lower(name) → course
  const byNorm = new Map();  // normalize(name) → [courses]
  for (const c of catalogue) {
    byExact.set(c.name.toLowerCase().trim(), c);
    const n = normalize(c.name);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(c);
  }

  // Every training still missing a course_slug, plus its order payload slug (if any).
  const rows = await db
    .select({
      id: trainingIds.id,
      code: trainingIds.code,
      title: trainingIds.title,
      payloadSlug: sql`nullif(${orders.payload} -> 'course' ->> 'slug', '')`,
    })
    .from(trainingIds)
    .leftJoin(orders, eq(orders.trainingId, trainingIds.id))
    .where(isNull(trainingIds.courseSlug));

  // Dedupe trainings (a training may have several orders → several rows).
  const seen = new Map();
  for (const r of rows) {
    const prev = seen.get(r.id);
    if (!prev) seen.set(r.id, r);
    else if (!prev.payloadSlug && r.payloadSlug) seen.set(r.id, r); // prefer the row that carries a slug
  }

  let updated = 0;
  const bySource = { order_payload: 0, exact_name: 0, normalized_name: 0 };
  const ambiguous = [];
  const unresolved = [];

  for (const t of seen.values()) {
    let match = null;
    let source = null;

    // 1. Order payload slug (authoritative; matches how new orders resolve it).
    if (t.payloadSlug) {
      match = catalogue.find((c) => c.slug === t.payloadSlug) || { slug: t.payloadSlug, courseType: null, certificationIncluded: null };
      source = "order_payload";
    }

    // 2. Exact course-name match.
    if (!match) {
      const em = byExact.get((t.title || "").toLowerCase().trim());
      if (em) { match = em; source = "exact_name"; }
    }

    // 3. Normalized-unique match.
    if (!match) {
      const nm = byNorm.get(normalize(t.title || ""));
      if (nm && nm.length === 1) { match = nm[0]; source = "normalized_name"; }
      else if (nm && nm.length > 1) { ambiguous.push({ code: t.code, title: t.title, candidates: nm.map((c) => c.slug) }); }
    }

    if (!match) {
      if (!ambiguous.find((a) => a.code === t.code)) unresolved.push({ code: t.code, title: t.title });
      continue;
    }

    await db
      .update(trainingIds)
      .set({
        courseSlug: match.slug,
        // Only stamp facts we actually have; leave existing/nulls otherwise.
        ...(match.courseType != null ? { courseType: match.courseType } : {}),
        ...(match.certificationIncluded != null ? { certificationIncluded: match.certificationIncluded } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(trainingIds.id, t.id), isNull(trainingIds.courseSlug)));

    updated += 1;
    bySource[source] += 1;
  }

  console.log(`\ncourse_slug backfill complete — ${updated} training(s) updated.`);
  console.log(`  from order payload : ${bySource.order_payload}`);
  console.log(`  from exact name    : ${bySource.exact_name}`);
  console.log(`  from normalized    : ${bySource.normalized_name}`);

  if (ambiguous.length) {
    console.log(`\n${ambiguous.length} training(s) left NULL — ambiguous (multiple course matches), resolve manually:`);
    for (const a of ambiguous) console.log(`  ${a.code}  "${a.title}"  → candidates: ${a.candidates.join(", ")}`);
  }
  if (unresolved.length) {
    console.log(`\n${unresolved.length} training(s) left NULL — no matching course in the catalogue:`);
    for (const u of unresolved) console.log(`  ${u.code}  "${u.title}"`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
