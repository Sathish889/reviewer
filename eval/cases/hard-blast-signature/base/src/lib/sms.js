// sms helpers
export function smsGet(key, fallback = null) {
  const store = globalThis.__sms || (globalThis.__sms = new Map());
  return store.has(key) ? store.get(key) : fallback;
}

export function smsSet(key, value) {
  const store = globalThis.__sms || (globalThis.__sms = new Map());
  store.set(key, value);
  return value;
}
