import { request } from '../http/client.js';
export const capture = (id) => request(`/payments/${id}/capture`);
