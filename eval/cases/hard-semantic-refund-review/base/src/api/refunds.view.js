import { formatRefund } from '../refunds/format.js';
export const renderRefundRow = (r) => `<td>${formatRefund(r)}</td>`;
