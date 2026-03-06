import type { RuntimeInfo } from "./driver-adapter.js";

/**
 * Detects the current JavaScript runtime environment.
 *
 * Detection order:
 * 1. Bun — checks `globalThis.Bun`
 * 2. Deno — checks `globalThis.Deno`
 * 3. Edge — checks `globalThis.EdgeRuntime` or Cloudflare Workers navigator UA
 *    (must come before Node, since some Edge runtimes polyfill process.versions.node)
 * 4. Node.js — checks `globalThis.process?.versions?.node`
 * 5. Unknown edge — fallback
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

  // Edge runtime — check BEFORE Node since some Edge runtimes (Next.js Edge,
  // Vercel Edge) polyfill process.versions.node
  const nav = (globalThis as any).navigator;
  if (
    typeof (globalThis as any).EdgeRuntime === "string" ||
    (nav != null && typeof nav.userAgent === "string" && nav.userAgent.includes("Cloudflare-Workers"))
  ) {
    return {
      runtime: "edge",
      version: "unknown",
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

  // Fallback: unknown edge environment
  return {
    runtime: "edge",
    version: "unknown",
  };
}
