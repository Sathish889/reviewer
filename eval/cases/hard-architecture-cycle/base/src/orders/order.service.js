import { isValidEmail } from '../lib/validate.js';
export function orderTotal(order) {
  return order.lines.reduce((s, l) => s + l.qty * l.price, 0);
}
export function createOrder(input) {
  if (!isValidEmail(input.email)) throw new Error('bad email');
  return { ...input, total: orderTotal(input) };
}
