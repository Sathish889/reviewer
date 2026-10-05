import { roundHalfEven, fromMinorUnits } from '../money/amounts.js';

// Monthly merchant statement: totals per merchant, rounded for display.
export function monthlyTotals(rows) {
  return rows.map((r) => ({ merchant: r.merchant, total: fromMinorUnits(roundHalfEven(r.total)) }));
}
