import { parseAmount } from '../money/amounts.js';

export function handleParse(input) {
  return parseAmount(input.amount);
}
