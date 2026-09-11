/** Error normalisation helpers. */

/** Wrap any thrown value into an `Error`. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/** Human-readable message for any thrown value. */
export function errorMessage(value: unknown): string {
  return toError(value).message;
}
