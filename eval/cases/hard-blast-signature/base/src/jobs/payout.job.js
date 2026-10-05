import { getMerchant } from '../merchants/merchant.repo.js';
// Nightly: pay out every merchant with a positive balance.
export async function runPayouts(db, bank, balances) {
  for (const b of balances) {
    const merchant = await getMerchant(db, b.merchantId);
    if (!merchant) continue;
    await bank.payout(merchant.iban, b.amount);
  }
}
