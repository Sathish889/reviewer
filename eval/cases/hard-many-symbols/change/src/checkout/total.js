import { toMinorUnits } from '../money/amounts.js';

export function handleTotal(input, ctx) {
  return toMinorUnits(ctx, input.amount);
}
