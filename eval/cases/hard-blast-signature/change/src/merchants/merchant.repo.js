// Multi-tenant: every merchant lookup is scoped to its tenant.
export async function getMerchant(db, tenantId, id) {
  return db.merchants.findOne({ tenantId, id });
}

export async function listMerchants(db, tenantId, page = 1) {
  return db.merchants.find({ tenantId }, { skip: (page - 1) * 50, limit: 50 });
}
