export function calculateTotal(lines, taxRate) {
  const net = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  return Math.round(net * (1 + taxRate));
}
