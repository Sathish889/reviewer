import { toMinorUnits } from '../money/amounts.js';

export function handleTotal(input) {
  return toMinorUnits(input.amount);
}
