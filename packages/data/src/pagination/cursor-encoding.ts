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
function isPrimitive(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = base64ToUtf8(cursor);
    const parsed = JSON.parse(json);

    // Must be a plain object (not array, null, primitive)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid cursor structure");
    }

    // Only allow known keys to prevent prototype pollution
    const keys = Object.keys(parsed);
    for (const key of keys) {
      if (key !== "values" && key !== "id") {
        throw new Error("Invalid cursor structure");
      }
    }

    if (!Array.isArray(parsed.values)) {
      throw new Error("Invalid cursor structure");
    }

    // Values must be an array of primitives (no nested objects)
    for (const v of parsed.values) {
      if (!isPrimitive(v)) {
        throw new Error("Invalid cursor structure");
      }
    }

    // id must be present and a primitive (or null)
    if (!("id" in parsed) || !isPrimitive(parsed.id)) {
      throw new Error("Invalid cursor structure");
    }

    return { values: parsed.values, id: parsed.id };
  } catch (err) {
    if (err instanceof Error && err.message === "Invalid cursor structure") {
      throw err;
    }
    throw new Error(`Invalid cursor: ${err instanceof Error ? err.message : String(err)}`);
  }
}
