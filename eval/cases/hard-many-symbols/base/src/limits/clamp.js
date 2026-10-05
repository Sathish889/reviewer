import { clampAmount } from '../money/amounts.js';

export function handleClamp(input) {
  return clampAmount(input.amount);
}
