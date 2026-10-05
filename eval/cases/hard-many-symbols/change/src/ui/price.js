import { formatAmount } from '../money/amounts.js';

export function handlePrice(input, ctx) {
  return formatAmount(ctx, input.amount);
}
