import { calculateTotal } from '../pricing/totals.js';

export function checkout(cart) {
  const total = calculateTotal(cart.lines, cart.taxRate);
  return { total, currency: cart.currency };
}
