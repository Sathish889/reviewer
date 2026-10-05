import { parseAmount } from '../money/amounts.js';

export function handleParse(input, ctx) {
  return parseAmount(ctx, input.amount);
}
