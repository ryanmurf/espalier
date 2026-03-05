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
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
