/**
 * Cursor value payload — the data encoded in a cursor string.
 */
export interface CursorPayload {
  /** Values of the sort columns at this cursor position. */
  values: unknown[];
  /** The primary key value for tie-breaking. */
  id: unknown;
}

/**
 * Encode a cursor payload to a base64 string.
 * Uses globalThis.btoa (available in Node 16+, Deno, Bun, browsers).
 */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return btoa(json);
}

/**
 * Decode a base64 cursor string back to a CursorPayload.
 * @throws Error if the cursor is invalid.
 */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = atob(cursor);
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.values) || parsed.id === undefined) {
      throw new Error("Invalid cursor structure");
    }
    return parsed as CursorPayload;
  } catch (err) {
    if (err instanceof Error && err.message === "Invalid cursor structure") {
      throw err;
    }
    throw new Error(`Invalid cursor: ${err instanceof Error ? err.message : String(err)}`);
  }
}
