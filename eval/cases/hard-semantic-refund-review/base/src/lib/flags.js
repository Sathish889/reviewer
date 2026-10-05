// flags helpers
export function flagsGet(key, fallback = null) {
  const store = globalThis.__flags || (globalThis.__flags = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function flagsSet(key, value) {
  const store = globalThis.__flags || (globalThis.__flags = new Map());
  store.set(key, value);
  return value;
}
