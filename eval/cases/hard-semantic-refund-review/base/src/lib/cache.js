// cache helpers
export function cacheGet(key, fallback = null) {
  const store = globalThis.__cache || (globalThis.__cache = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function cacheSet(key, value) {
  const store = globalThis.__cache || (globalThis.__cache = new Map());
  store.set(key, value);
  return value;
}
