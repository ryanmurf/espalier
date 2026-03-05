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
 * Cross-runtime UTF-8 to base64 encoding.
 * Uses TextEncoder + btoa with percent-encoding bridge for unicode safety.
 * Works in Node, Deno, Bun, and browsers without requiring Buffer.
 */
function utf8ToBase64(str: string): string {
  // Encode to UTF-8 bytes, convert each byte to a Latin-1 char for btoa
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Cross-runtime base64 to UTF-8 decoding.
 */
function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a cursor payload to a base64 string.
 * Uses TextEncoder for unicode safety (btoa alone only handles Latin-1).
 */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return utf8ToBase64(json);
}

/**
 * Decode a base64 cursor string back to a CursorPayload.
 * @throws Error if the cursor is invalid.
 */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = base64ToUtf8(cursor);
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
