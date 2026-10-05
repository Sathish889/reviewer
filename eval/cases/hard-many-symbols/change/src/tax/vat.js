import { applyVat } from '../money/amounts.js';

export function handleVat(input, ctx) {
  return applyVat(ctx, input.amount);
}
