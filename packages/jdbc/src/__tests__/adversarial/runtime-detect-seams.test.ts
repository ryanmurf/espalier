/**
 * Adversarial regression tests for detectRuntime() seams.
 *
 * Tests the boundary between runtime detection and the rest of the system:
 * - Does detection interact correctly with factory registration?
 * - Does mutation of globalThis produce wrong results?
 * - Are edge cases (null globals, mixed environments) handled?
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectRuntime } from "../../runtime-detect.js";

describe("detectRuntime seam tests", () => {
  const originalBun = (globalThis as any).Bun;
  const originalDeno = (globalThis as any).Deno;
  const originalProcess = (globalThis as any).process;

  afterEach(() => {
    // Restore original globals
    if (originalBun !== undefined) {
      (globalThis as any).Bun = originalBun;
    } else {
      delete (globalThis as any).Bun;
    }
    if (originalDeno !== undefined) {
      (globalThis as any).Deno = originalDeno;
    } else {
      delete (globalThis as any).Deno;
    }
    (globalThis as any).process = originalProcess;
  });

  it("detects node runtime in Node.js environment", () => {
    // Clean environment — Node.js has process.versions.node
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    const info = detectRuntime();
    expect(info.runtime).toBe("node");
    expect(info.version).toBeTruthy();
    expect(info.version).not.toBe("unknown");
  });

  it("returns edge when no runtime markers exist", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    const savedProcess = (globalThis as any).process;
    delete (globalThis as any).process;
    try {
      const info = detectRuntime();
      expect(info.runtime).toBe("edge");
      expect(info.version).toBe("unknown");
    } finally {
      (globalThis as any).process = savedProcess;
    }
  });

  it("Bun with version=null does not crash (regression for #25)", () => {
    (globalThis as any).Bun = { version: null };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
    // version should be coerced to string "null" not crash
    expect(info.version).toBeDefined();
  });

  it("Bun with version=undefined returns 'unknown'", () => {
    (globalThis as any).Bun = {};
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
    expect(info.version).toBe("unknown");
  });

  it("Bun takes priority over Deno when both globals exist", () => {
    (globalThis as any).Bun = { version: "1.0.0" };
    (globalThis as any).Deno = { version: { deno: "2.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
  });

  it("Bun takes priority over Node when both exist", () => {
    (globalThis as any).Bun = { version: "1.0.0" };
    // process.versions.node is already set in Node.js
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
  });

  it("Deno takes priority over Node when both exist", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: { deno: "2.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
  });

  it("Deno with null version object does not crash", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: null };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    expect(info.version).toBe("unknown");
  });

  it("Deno with empty version object returns unknown", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: {} };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    expect(info.version).toBe("unknown");
  });

  it("Deno with numeric version does not crash", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: { deno: 123 } };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    // Non-string version should be treated as unknown
    expect(info.version).toBe("unknown");
  });

  it("process with no versions property falls through to edge", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = {};
    const info = detectRuntime();
    expect(info.runtime).toBe("edge");
  });

  it("process with versions.node as number does not detect as node", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = { versions: { node: 20 } };
    const info = detectRuntime();
    // Should not detect as node since version is not a string
    expect(info.runtime).toBe("edge");
  });

  it("returns consistent results across multiple calls", () => {
    const r1 = detectRuntime();
    const r2 = detectRuntime();
    expect(r1.runtime).toBe(r2.runtime);
    expect(r1.version).toBe(r2.version);
  });

  it("RuntimeInfo type has exactly the expected shape", () => {
    const info = detectRuntime();
    expect(typeof info.runtime).toBe("string");
    expect(typeof info.version).toBe("string");
    expect(["node", "bun", "deno", "edge"]).toContain(info.runtime);
  });
});
