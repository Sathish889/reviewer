// timeoutMs = 0 disables the timeout entirely.
export function request(url, { timeoutMs = 30000, retries = 2 } = {}) {
  return { url, timeoutMs, retries };
}
