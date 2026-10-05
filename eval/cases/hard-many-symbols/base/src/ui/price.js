import { formatAmount } from '../money/amounts.js';

export function handlePrice(input) {
  return formatAmount(input.amount);
}
