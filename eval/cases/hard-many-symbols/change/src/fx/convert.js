import { convertCurrency } from '../money/amounts.js';

export function handleConvert(input, ctx) {
  return convertCurrency(ctx, input.amount);
}
