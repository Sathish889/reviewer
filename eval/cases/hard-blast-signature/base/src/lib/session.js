// session helpers
export function sessionGet(key, fallback = null) {
  const store = globalThis.__session || (globalThis.__session = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function sessionSet(key, value) {
  const store = globalThis.__session || (globalThis.__session = new Map());
  store.set(key, value);
  return value;
}
