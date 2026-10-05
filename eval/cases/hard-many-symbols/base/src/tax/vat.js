import { applyVat } from '../money/amounts.js';

export function handleVat(input) {
  return applyVat(input.amount);
}
