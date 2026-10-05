// tokens helpers
export function tokensGet(key, fallback = null) {
  const store = globalThis.__tokens || (globalThis.__tokens = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function tokensSet(key, value) {
  const store = globalThis.__tokens || (globalThis.__tokens = new Map());
  store.set(key, value);
  return value;
}
