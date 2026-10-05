// config helpers
export function configGet(key, fallback = null) {
  const store = globalThis.__config || (globalThis.__config = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function configSet(key, value) {
  const store = globalThis.__config || (globalThis.__config = new Map());
  store.set(key, value);
  return value;
}
