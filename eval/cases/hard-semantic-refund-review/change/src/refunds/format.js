export function describeRefund(r) {
  const suffix = r.review ? ' (in review)' : '';
  return `${r.refundId || '-'} ${r.status}${suffix}`;
}
