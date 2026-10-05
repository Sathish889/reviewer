import { calculateTotal } from './totals.js';
test('adds tax', () => { expect(calculateTotal([{ price: 100, qty: 1 }], 0.25)).toBe(125); });
