import { sql } from "drizzle-orm";
import { db, pool } from "../config/db.js";

/**
 * One-time cleanup for case-duplicate emails created BEFORE emails were
 * normalized to lowercase (see the schemas). Two rows whose emails differ only
 * by case (e.g. "John@x.com" / "john@x.com") are merged into one canonical row,
 * then every email is lowercased.
 *
 *   node src/db/dedupe-emails.js            # DRY RUN — report only
 *   node src/db/dedupe-emails.js --apply    # perform the merge (in one txn)
 *
 * Canonical row per group = the already-lowercase one if present, else the
 * oldest. All FK references are repointed from duplicates to the canonical row.
 */
const APPLY = process.argv.includes("--apply");

// Every column that references users.id (repointed on a user merge).
const USER_FKS = [
  ["revoked_refresh_tokens", "user_id"],
  ["schedules", "created_by"],
  ["training_ids", "created_by"],
  ["training_ids", "meeting_triggered_by"],
  ["trainers", "user_id"],
  ["trainer_assignments", "assigned_by"],
  ["participants", "user_id"],
  ["orders", "sponsor_user_id"],
  ["audit_log", "actor_id"],
];

async function groups(exec, table) {
  const res = await exec.execute(sql`
    SELECT lower(email) AS key, count(*)::int AS n, array_agg(email) AS emails
    FROM ${sql.identifier(table)}
    GROUP BY lower(email) HAVING count(*) > 1
    ORDER BY key
  `);
  return res.rows ?? [];
}

async function canonicalAndDups(tx, table, key) {
  // Prefer an already-lowercase row, then the oldest.
  const res = await tx.execute(sql`
    SELECT id FROM ${sql.identifier(table)}
    WHERE lower(email) = ${key}
    ORDER BY (email = lower(email)) DESC, created_at ASC
  `);
  const ids = res.rows.map((r) => r.id);
  return { canonical: ids[0], dups: ids.slice(1) };
}

async function mergeUsers(tx, key) {
  const { canonical, dups } = await canonicalAndDups(tx, "users", key);
  for (const dup of dups) {
    for (const [table, col] of USER_FKS) {
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(col)} = ${canonical} WHERE ${sql.identifier(col)} = ${dup}`
      );
    }
    await tx.execute(sql`DELETE FROM users WHERE id = ${dup}`);
  }
  await tx.execute(sql`UPDATE users SET email = lower(email), updated_at = now() WHERE id = ${canonical}`);
  return dups.length;
}

async function mergeParticipants(tx, key) {
  const { canonical, dups } = await canonicalAndDups(tx, "participants", key);
  for (const dup of dups) {
    // Drop dup enrolments that would collide with an active canonical enrolment
    // for the same training (partial unique index), then repoint the rest.
    await tx.execute(sql`
      DELETE FROM enrolments d
      WHERE d.participant_id = ${dup}
        AND EXISTS (
          SELECT 1 FROM enrolments c
          WHERE c.participant_id = ${canonical}
            AND c.training_id = d.training_id
            AND c.status NOT IN ('cancelled', 'transferred')
        )
    `);
    await tx.execute(sql`UPDATE enrolments SET participant_id = ${canonical} WHERE participant_id = ${dup}`);
    await tx.execute(sql`DELETE FROM participants WHERE id = ${dup}`);
  }
  await tx.execute(sql`UPDATE participants SET email = lower(email), updated_at = now() WHERE id = ${canonical}`);
  return dups.length;
}

async function main() {
  console.log(APPLY ? "MODE: APPLY — will modify data" : "MODE: DRY RUN — no changes (pass --apply to execute)\n");

  const userGroups = await groups(db, "users");
  const partGroups = await groups(db, "participants");
  const mixedUsers = (await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE email <> lower(email)`)).rows[0].n;
  const mixedParts = (await db.execute(sql`SELECT count(*)::int AS n FROM participants WHERE email <> lower(email)`)).rows[0].n;

  console.log(`users:        ${userGroups.length} case-duplicate group(s), ${mixedUsers} mixed-case row(s)`);
  userGroups.forEach((g) => console.log(`  - ${g.key}  (${g.n}: ${g.emails.join(", ")})`));
  console.log(`participants: ${partGroups.length} case-duplicate group(s), ${mixedParts} mixed-case row(s)`);
  partGroups.forEach((g) => console.log(`  - ${g.key}  (${g.n}: ${g.emails.join(", ")})`));

  if (!APPLY) {
    if (userGroups.length || partGroups.length || mixedUsers || mixedParts) {
      console.log("\nRun again with --apply to merge duplicates and lowercase all emails.");
    } else {
      console.log("\nNothing to do — all emails are already unique and lowercase.");
    }
    await pool.end();
    return;
  }

  let mergedUsers = 0;
  let mergedParts = 0;
  await db.transaction(async (tx) => {
    for (const g of await groups(tx, "users")) mergedUsers += await mergeUsers(tx, g.key);
    for (const g of await groups(tx, "participants")) mergedParts += await mergeParticipants(tx, g.key);
    // Lowercase any remaining singletons (no collisions left after merges).
    await tx.execute(sql`UPDATE users SET email = lower(email), updated_at = now() WHERE email <> lower(email)`);
    await tx.execute(sql`UPDATE participants SET email = lower(email), updated_at = now() WHERE email <> lower(email)`);
    // Merges can change confirmed-enrolment counts — recompute enrolled_count.
    await tx.execute(sql`
      UPDATE training_ids t
      SET enrolled_count = COALESCE(
        (SELECT count(*)::int FROM enrolments e WHERE e.training_id = t.id AND e.status = 'confirmed'), 0
      ), updated_at = now()
    `);
  });

  console.log(`\nMerged ${mergedUsers} duplicate user(s) and ${mergedParts} duplicate participant(s); all emails lowercased.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
