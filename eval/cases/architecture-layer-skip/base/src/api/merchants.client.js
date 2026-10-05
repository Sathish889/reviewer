export async function listMerchants(http) {
  const res = await http.get('/api/merchants');
  return res.data;
}
