export const Status = { SUCCESS: 'SUCCESS', SCHEDULED: 'SCHEDULED', FAILED: 'FAILED' };

// Deactivate now, or book the deactivation for a later date. Both are a successful request.
export async function deactivateMerchant(repo, id, effectiveAt) {
  const merchant = await repo.find(id);
  if (!merchant) return { status: Status.FAILED, reason: 'not found' };
  if (effectiveAt && effectiveAt > Date.now()) {
    await repo.scheduleDeactivation(id, effectiveAt);
    return { status: Status.SUCCESS, scheduledFor: effectiveAt };
  }
  await repo.deactivate(id);
  return { status: Status.SUCCESS };
}
