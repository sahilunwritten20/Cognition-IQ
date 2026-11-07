/** Returns the index key pattern when `err` is a MongoDB duplicate-key error, otherwise null. */
export function duplicateKey(err: unknown): { keyPattern: Record<string, number> } | null {
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    return { keyPattern: (err as { keyPattern?: Record<string, number> }).keyPattern ?? {} };
  }
  return null;
}
