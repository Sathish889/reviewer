// sanitize helpers
export function sanitizeGet(key, fallback = null) {
  const store = globalThis.__sanitize || (globalThis.__sanitize = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function sanitizeSet(key, value) {
  const store = globalThis.__sanitize || (globalThis.__sanitize = new Map());
  store.set(key, value);
  return value;
}
