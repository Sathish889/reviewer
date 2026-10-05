import { sumAmounts } from '../money/amounts.js';

export function handleSum(input, ctx) {
  return sumAmounts(ctx, input.amount);
}
