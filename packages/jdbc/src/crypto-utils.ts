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
