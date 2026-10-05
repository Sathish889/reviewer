import { formatCurrency } from '../lib/money.js';
export const renderTotal = (inv) => formatCurrency(inv.total, inv.currency);
