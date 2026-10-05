export async function syncAll(items, send, size = 50) {
  for (let i = 0; i < items.length; i += size) {
    await send(items.slice(i, i + size));
  }
}

export function lastPage(total, size) {
  return Math.ceil(total / size);
}
