export async function getMerchant(db, id) {
  return db.merchants.findOne({ id });
}

export async function listMerchants(db, page = 1) {
  return db.merchants.find({}, { skip: (page - 1) * 50, limit: 50 });
}
