import { applyFee } from '../money/amounts.js';

export function handleFees(input, ctx) {
  return applyFee(ctx, input.amount);
}
