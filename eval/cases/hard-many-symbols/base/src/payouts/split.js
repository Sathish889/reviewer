import { splitAmount } from '../money/amounts.js';

export function handleSplit(input) {
  return splitAmount(input.amount);
}
