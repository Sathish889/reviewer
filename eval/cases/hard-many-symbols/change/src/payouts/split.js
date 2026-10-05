import { splitAmount } from '../money/amounts.js';

export function handleSplit(input, ctx) {
  return splitAmount(ctx, input.amount);
}
