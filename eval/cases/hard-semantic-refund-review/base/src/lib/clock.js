// clock helpers
export function clockGet(key, fallback = null) {
  const store = globalThis.__clock || (globalThis.__clock = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function clockSet(key, value) {
  const store = globalThis.__clock || (globalThis.__clock = new Map());
  store.set(key, value);
  return value;
}
