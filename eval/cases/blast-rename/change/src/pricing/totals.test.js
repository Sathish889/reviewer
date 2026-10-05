import { computeTotal } from './totals.js';
test('adds tax', () => { expect(computeTotal([{ price: 100, qty: 1 }], 0.25)).toBe(125); });
