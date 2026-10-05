import { compareAmounts } from '../money/amounts.js';

export function handleCompare(input) {
  return compareAmounts(input.amount);
}
