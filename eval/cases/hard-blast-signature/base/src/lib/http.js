// http helpers
export function httpGet(key, fallback = null) {
  const store = globalThis.__http || (globalThis.__http = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function httpSet(key, value) {
  const store = globalThis.__http || (globalThis.__http = new Map());
  store.set(key, value);
  return value;
}
