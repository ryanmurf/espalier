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
 */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  // Use btoa if available (browser/modern Node), fallback to Buffer
  if (typeof btoa === "function") {
    return btoa(json);
  }
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Decode a base64 cursor string back to a CursorPayload.
 * @throws Error if the cursor is invalid.
 */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    let json: string;
    if (typeof atob === "function") {
      json = atob(cursor);
    } else {
      json = Buffer.from(cursor, "base64").toString("utf-8");
    }
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
