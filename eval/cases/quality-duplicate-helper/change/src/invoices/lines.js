export function renderLine(line) {
  const major = (line.amount / 100).toFixed(2);
  const [whole, frac] = major.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${line.label}: ${grouped},${frac} ${line.currency}`;
}
