import { loggerGet } from '../lib/logger.js';
import { RefundStatus } from './status.js';

const MANUAL_REVIEW_ABOVE = 50000; // minor units

export async function requestRefund(db, payment, amount) {
  if (amount <= 0 || amount > payment.captured) {
    return { status: RefundStatus.REJECTED, reason: 'invalid amount' };
  }
  const log = loggerGet('refunds');
  const refund = await db.refunds.insert({ paymentId: payment.id, amount, state: 'new' });
  if (amount > MANUAL_REVIEW_ABOVE) {
    await db.reviews.enqueue({ refundId: refund.id, reason: 'amount' });
    log && log.info('refund queued for manual review', { refundId: refund.id });
    // The request itself was accepted; the review decides later.
    return { status: RefundStatus.APPROVED, refundId: refund.id, review: true };
  }
  await db.ledger.reserve(payment.merchantId, amount);
  return { status: RefundStatus.APPROVED, refundId: refund.id };
}
