import { convertCurrency } from '../money/amounts.js';

export function handleConvert(input) {
  return convertCurrency(input.amount);
}
