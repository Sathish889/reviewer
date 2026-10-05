// metrics helpers
export function metricsGet(key, fallback = null) {
  const store = globalThis.__metrics || (globalThis.__metrics = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function metricsSet(key, value) {
  const store = globalThis.__metrics || (globalThis.__metrics = new Map());
  store.set(key, value);
  return value;
}
