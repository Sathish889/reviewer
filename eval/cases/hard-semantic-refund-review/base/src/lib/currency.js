// currency helpers
export function currencyGet(key, fallback = null) {
  const store = globalThis.__currency || (globalThis.__currency = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function currencySet(key, value) {
  const store = globalThis.__currency || (globalThis.__currency = new Map());
  store.set(key, value);
  return value;
}
