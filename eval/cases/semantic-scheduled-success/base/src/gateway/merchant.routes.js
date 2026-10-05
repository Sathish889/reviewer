import { deactivateMerchant, Status } from '../merchant/merchant.service.js';
import { deactivateStores } from '../stores/stores.service.js';

export async function deactivateRoute(req, res, repo) {
  const result = await deactivateMerchant(repo, req.params.id, req.body.effectiveAt);
  // Cascade only once the merchant really is deactivated.
  if (result.status === Status.SUCCESS) {
    await deactivateStores(req.params.id);
  }
  res.json(result);
}
