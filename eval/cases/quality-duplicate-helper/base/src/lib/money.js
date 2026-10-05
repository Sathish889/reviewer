export function formatCurrency(amountMinor, currency) {
  const major = (amountMinor / 100).toFixed(2);
  const [whole, frac] = major.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${frac} ${currency}`;
}
