// email helpers
export function emailGet(key, fallback = null) {
  const store = globalThis.__email || (globalThis.__email = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function emailSet(key, value) {
  const store = globalThis.__email || (globalThis.__email = new Map());
  store.set(key, value);
  return value;
}
