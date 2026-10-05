export function formatRefund(r) {
  return `${r.refundId || '-'} ${r.status}`;
}
