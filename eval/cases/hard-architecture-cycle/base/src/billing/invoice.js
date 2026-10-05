import { orderTotal } from '../orders/order.service.js';
export function buildInvoice(order) {
  return { number: `INV-${order.id}`, amount: orderTotal(order) };
}
