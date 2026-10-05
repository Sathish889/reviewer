import { loggerGet } from '../lib/logger.js';
import { RefundStatus } from './status.js';

export async function requestRefund(db, payment, amount) {
  if (amount <= 0 || amount > payment.captured) {
    return { status: RefundStatus.REJECTED, reason: 'invalid amount' };
  }
  const refund = await db.refunds.insert({ paymentId: payment.id, amount, state: 'new' });
  await db.ledger.reserve(payment.merchantId, amount);
  return { status: RefundStatus.APPROVED, refundId: refund.id };
}
