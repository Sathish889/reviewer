import { RefundStatus } from '../refunds/status.js';

// Runs on every refund.created event. APPROVED means the money may leave now.
export async function onRefundCreated(event, bank) {
  if (event.result.status === RefundStatus.APPROVED) {
    await bank.releaseFunds(event.result.refundId);
  }
}
