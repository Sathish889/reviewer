// logger helpers
export function loggerGet(key, fallback = null) {
  const store = globalThis.__logger || (globalThis.__logger = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function loggerSet(key, value) {
  const store = globalThis.__logger || (globalThis.__logger = new Map());
  store.set(key, value);
  return value;
}
