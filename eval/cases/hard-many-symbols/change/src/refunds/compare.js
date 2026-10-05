import { compareAmounts } from '../money/amounts.js';

export function handleCompare(input, ctx) {
  return compareAmounts(ctx, input.amount);
}
