// queue helpers
export function queueGet(key, fallback = null) {
  const store = globalThis.__queue || (globalThis.__queue = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function queueSet(key, value) {
  const store = globalThis.__queue || (globalThis.__queue = new Map());
  store.set(key, value);
  return value;
}
