import { buildInvoice } from '../billing/invoice.js';

export function orderTotal(order) {
  return order.lines.reduce((s, l) => s + l.qty * l.price, 0);
}

function emailLooksValid(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function createOrder(input) {
  if (!emailLooksValid(input.email)) throw new Error('bad email');
  const order = { ...input, total: orderTotal(input) };
  return { order, invoice: buildInvoice(order) };
}
