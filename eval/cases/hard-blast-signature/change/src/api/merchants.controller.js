import { getMerchant } from '../merchants/merchant.repo.js';
export async function show(req, res, db) {
  const m = await getMerchant(db, req.tenant.id, req.params.id);
  res.json(m);
}
