import { getMerchant } from '../merchants/merchant.repo.js';
export async function storesFor(req, res, db) {
  const m = await getMerchant(db, req.tenant.id, req.params.merchantId);
  res.json(m ? m.stores : []);
}
