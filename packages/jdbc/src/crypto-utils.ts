/**
 * Compute a SHA-256 hash of the given input string, returning a hex-encoded digest.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`), which is available in
 * Node.js 18+, Bun, Deno, and Cloudflare Workers — no polyfills needed.
 */
export async function sha256(input: string): Promise<string> {
  const encoder = new (globalThis as any).TextEncoder();
  const data: Uint8Array = encoder.encode(input);
  const hashBuffer: ArrayBuffer = await (globalThis as any).crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hexParts: string[] = [];
  for (let i = 0; i < hashArray.length; i++) {
    hexParts.push(hashArray[i].toString(16).padStart(2, "0"));
  }
  return hexParts.join("");
}

/**
 * Constant-time comparison of two Uint8Arrays.
 *
 * Always compares every byte regardless of where a mismatch occurs,
 * preventing timing side-channel attacks on hash comparisons.
 *
 * @returns true if both arrays are non-null, same length, and identical byte-by-byte
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length === b.length ? 0 : 1; // length mismatch contributes to result
  for (let i = 0; i < maxLen; i++) {
    result |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return result === 0;
}
