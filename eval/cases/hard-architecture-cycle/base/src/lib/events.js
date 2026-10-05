// events helpers
export function eventsGet(key, fallback = null) {
  const store = globalThis.__events || (globalThis.__events = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function eventsSet(key, value) {
  const store = globalThis.__events || (globalThis.__events = new Map());
  store.set(key, value);
  return value;
}
