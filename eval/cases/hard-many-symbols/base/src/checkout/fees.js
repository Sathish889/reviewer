import { applyFee } from '../money/amounts.js';

export function handleFees(input) {
  return applyFee(input.amount);
}
