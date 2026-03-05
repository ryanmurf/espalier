import type { RuntimeInfo } from "./driver-adapter.js";

/**
 * Detects the current JavaScript runtime environment.
 *
 * Detection order:
 * 1. Bun — checks `globalThis.Bun`
 * 2. Deno — checks `globalThis.Deno`
 * 3. Edge — checks for `navigator.userAgent` containing "Cloudflare-Workers" or
 *    absence of Node/Bun/Deno globals in a non-browser environment
 * 4. Node.js — fallback, checks `globalThis.process?.versions?.node`
 */
export function detectRuntime(): RuntimeInfo {
  // Bun sets globalThis.Bun
  if ((globalThis as any).Bun != null) {
    return {
      runtime: "bun",
      version: String((globalThis as any).Bun.version ?? "unknown"),
    };
  }

  // Deno sets globalThis.Deno
  if ((globalThis as any).Deno != null) {
    const deno = (globalThis as any).Deno;
    return {
      runtime: "deno",
      version: typeof deno.version?.deno === "string" ? deno.version.deno : "unknown",
    };
  }

  // Node.js — check process.versions.node
  if (
    typeof (globalThis as any).process !== "undefined" &&
    typeof (globalThis as any).process.versions?.node === "string"
  ) {
    return {
      runtime: "node",
      version: (globalThis as any).process.versions.node,
    };
  }

  // Edge runtime (Cloudflare Workers, Vercel Edge, etc.)
  return {
    runtime: "edge",
    version: "unknown",
  };
}
