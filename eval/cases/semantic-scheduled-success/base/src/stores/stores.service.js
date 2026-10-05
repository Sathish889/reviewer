export async function deactivateStores(merchantId) {
  // irreversible: terminals are unpaired from the merchant
  return { merchantId, deactivated: true };
}
