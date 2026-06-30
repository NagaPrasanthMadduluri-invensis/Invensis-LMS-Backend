import { sql } from "drizzle-orm";
import { db } from "../config/db.js";

/**
 * Resolve what an account can access.
 *
 * `role` is the default landing portal; capabilities are derived from the
 * RELATIONSHIPS the account has, so one account can be several things at once
 * (e.g. both sponsor and learner). The assigned `role` is also honoured, so an
 * explicitly-assigned role isn't hidden before its relationships exist
 * (e.g. a fresh sponsor account with no orders yet still reports sponsor:true).
 *
 *   sponsor  → owns ≥1 order            (orders.sponsor_user_id = me)
 *   learner  → has ≥1 confirmed enrolment (participants.user_id = me)
 *   trainer  → has a trainers row
 *   admin    → role is admin
 */
export async function resolveCapabilities(user) {
  const res = await db.execute(sql`
    SELECT
      EXISTS(SELECT 1 FROM trainers WHERE user_id = ${user.id}) AS is_trainer,
      EXISTS(SELECT 1 FROM orders   WHERE sponsor_user_id = ${user.id}) AS is_sponsor,
      EXISTS(
        SELECT 1 FROM enrolments e
        JOIN participants p ON p.id = e.participant_id
        WHERE p.user_id = ${user.id} AND e.status = 'confirmed'
      ) AS is_learner
  `);
  const r = res.rows?.[0] ?? {};
  return {
    admin: user.role === "admin",
    trainer: user.role === "trainer" || r.is_trainer === true,
    sponsor: user.role === "sponsor" || r.is_sponsor === true,
    learner: user.role === "learner" || r.is_learner === true,
  };
}

/**
 * For a learner, who sponsored them — the buyer of the order their enrolment
 * came from. Self-sponsorship is excluded (a self-buyer is their own sponsor),
 * so this returns null for self-buyers, manually-added learners (no order), and
 * non-learners. If enrolled via multiple sponsors, returns the most recent.
 */
export async function resolveSponsor(userId) {
  const res = await db.execute(sql`
    SELECT u.id, u.name, u.email
    FROM enrolments e
    JOIN participants p ON p.id = e.participant_id
    JOIN orders o ON o.id = e.order_id
    JOIN users u ON u.id = o.sponsor_user_id
    WHERE p.user_id = ${userId}
      AND e.status = 'confirmed'
      AND o.sponsor_user_id <> ${userId}
    ORDER BY e.enrolled_at DESC
    LIMIT 1
  `);
  const r = res.rows?.[0];
  return r ? { id: r.id, name: r.name, email: r.email } : null;
}
