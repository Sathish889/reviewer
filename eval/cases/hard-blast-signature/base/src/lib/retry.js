// retry helpers
export function retryGet(key, fallback = null) {
  const store = globalThis.__retry || (globalThis.__retry = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function retrySet(key, value) {
  const store = globalThis.__retry || (globalThis.__retry = new Map());
  store.set(key, value);
  return value;
}
