import { clampAmount } from '../money/amounts.js';

export function handleClamp(input, ctx) {
  return clampAmount(ctx, input.amount);
}
