// ids helpers
export function idsGet(key, fallback = null) {
  const store = globalThis.__ids || (globalThis.__ids = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function idsSet(key, value) {
  const store = globalThis.__ids || (globalThis.__ids = new Map());
  store.set(key, value);
  return value;
}
