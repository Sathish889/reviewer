// locale helpers
export function localeGet(key, fallback = null) {
  const store = globalThis.__locale || (globalThis.__locale = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function localeSet(key, value) {
  const store = globalThis.__locale || (globalThis.__locale = new Map());
  store.set(key, value);
  return value;
}
