// storage helpers
export function storageGet(key, fallback = null) {
  const store = globalThis.__storage || (globalThis.__storage = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function storageSet(key, value) {
  const store = globalThis.__storage || (globalThis.__storage = new Map());
  store.set(key, value);
  return value;
}
