/**
 * Background job dispatch — STUB.
 *
 * The architecture uses BullMQ + Redis. Redis isn't wired up yet, so these are
 * no-ops that log intent, keeping the API flow complete. Swap the bodies for
 * real `queue.add(...)` calls (and add a worker) when Redis is available — the
 * call sites won't change.
 */
export async function enqueueMeetingLinkRelease(trainingId) {
  console.log(`[queue:stub] meeting-link-release → training ${trainingId} (would email learners + assigned trainers)`);
}
