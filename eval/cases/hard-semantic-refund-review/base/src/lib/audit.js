// audit helpers
export function auditGet(key, fallback = null) {
  const store = globalThis.__audit || (globalThis.__audit = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function auditSet(key, value) {
  const store = globalThis.__audit || (globalThis.__audit = new Map());
  store.set(key, value);
  return value;
}
