import { auditLog } from "../db/schema.js";

/**
 * Append an audit entry. Pass the active transaction (`tx`) so the audit row
 * commits atomically with the change it records. `exec` is a db or tx handle.
 */
export async function writeAudit(exec, entry) {
  await exec.insert(auditLog).values({
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    actorId: entry.actorId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    ipAddress: entry.ipAddress ?? null,
  });
}
