import { requestRefund } from '../src/refunds/refund.service.js';
test('rejects zero', async () => {
  const r = await requestRefund({}, { captured: 10 }, 0);
  expect(r.status).toBe('REJECTED');
});
test('queues large refunds for review', async () => {
  const db = { refunds: { insert: async () => ({ id: 'r1' }) }, reviews: { enqueue: async () => {} } };
  const r = await requestRefund(db, { captured: 100000, id: 'p' }, 60000);
  expect(r.review).toBe(true);
});
