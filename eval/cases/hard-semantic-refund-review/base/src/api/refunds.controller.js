import { requestRefund } from '../refunds/refund.service.js';
import { emit } from '../lib/events.js';

export async function postRefund(req, res, db) {
  const payment = await db.payments.get(req.params.paymentId);
  const result = await requestRefund(db, payment, Number(req.body.amount));
  emit('refund.created', { result });
  res.status(result.status === 'REJECTED' ? 422 : 201).json(result);
}
