import { requestRefund } from '../src/refunds/refund.service.js';
test('rejects zero', async () => {
  const r = await requestRefund({}, { captured: 10 }, 0);
  expect(r.status).toBe('REJECTED');
});
