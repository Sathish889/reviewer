import { getMerchant } from '../merchants/merchant.repo.js';
export async function onKycResult(event, db) {
  const merchant = await getMerchant(db, event.merchantId);
  if (!merchant) throw new Error('unknown merchant');
  await db.merchants.update({ id: merchant.id }, { kyc: event.result });
}
