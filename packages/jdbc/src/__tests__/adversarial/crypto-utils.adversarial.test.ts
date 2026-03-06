/**
 * Adversarial tests for crypto-utils (Web Crypto sha256 replacement).
 * Y4 Q2 — Task T2-Test
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../crypto-utils.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Reference SHA-256 using Node's crypto for comparison. */
function nodeSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ── 1. Hash Correctness — Web Crypto matches Node crypto ─────────────────────

describe("hash correctness — Web Crypto matches Node crypto", () => {
  it("empty string", async () => {
    const result = await sha256("");
    expect(result).toBe(nodeSha256(""));
  });

  it("simple ASCII string", async () => {
    const result = await sha256("hello world");
    expect(result).toBe(nodeSha256("hello world"));
  });

  it("single character", async () => {
    const result = await sha256("a");
    expect(result).toBe(nodeSha256("a"));
  });

  it("numeric string", async () => {
    const result = await sha256("1234567890");
    expect(result).toBe(nodeSha256("1234567890"));
  });

  it("unicode — CJK characters", async () => {
    const input = "你好世界";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("unicode — emoji", async () => {
    const input = "Hello 🌍🚀💻";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("unicode — combining diacriticals", async () => {
    const input = "café résumé naïve";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("unicode — right-to-left (Arabic)", async () => {
    const input = "مرحبا بالعالم";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("newlines and tabs", async () => {
    const input = "line1\nline2\ttab\rcarriage";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("null bytes embedded in string", async () => {
    const input = "before\x00after";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("long string (1MB)", async () => {
    const input = "x".repeat(1_000_000);
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("very long string (10MB)", async () => {
    const input = "abcdefghij".repeat(1_000_000);
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("binary-like content (all byte values as escape sequences)", async () => {
    // Build a string with diverse byte patterns
    let input = "";
    for (let i = 0; i < 256; i++) {
      input += String.fromCharCode(i);
    }
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("string with only whitespace", async () => {
    const input = "   \t\n\r  ";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("JSON content (typical migration SQL)", async () => {
    const input = `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`;
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("known SHA-256 test vector: empty string", async () => {
    const result = await sha256("");
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("known SHA-256 test vector: 'abc'", async () => {
    const result = await sha256("abc");
    expect(result).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("returns lowercase hex string", async () => {
    const result = await sha256("test");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns exactly 64 hex characters", async () => {
    const result = await sha256("anything");
    expect(result).toHaveLength(64);
  });
});

// ── 2. Determinism ───────────────────────────────────────────────────────────

describe("hash determinism", () => {
  it("same input always produces same output", async () => {
    const input = "deterministic";
    const r1 = await sha256(input);
    const r2 = await sha256(input);
    const r3 = await sha256(input);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it("different inputs produce different outputs", async () => {
    const results = await Promise.all([sha256("a"), sha256("b"), sha256("c"), sha256("ab"), sha256("abc")]);
    const unique = new Set(results);
    expect(unique.size).toBe(5);
  });

  it("case sensitivity — different case produces different hash", async () => {
    const lower = await sha256("hello");
    const upper = await sha256("HELLO");
    expect(lower).not.toBe(upper);
  });

  it("trailing whitespace matters", async () => {
    const noSpace = await sha256("hello");
    const withSpace = await sha256("hello ");
    expect(noSpace).not.toBe(withSpace);
  });

  it("leading whitespace matters", async () => {
    const noSpace = await sha256("hello");
    const withSpace = await sha256(" hello");
    expect(noSpace).not.toBe(withSpace);
  });
});

// ── 3. Missing crypto.subtle ─────────────────────────────────────────────────

describe("missing crypto.subtle", () => {
  let savedCrypto: typeof globalThis.crypto;

  afterEach(() => {
    // Restore the original crypto
    Object.defineProperty(globalThis, "crypto", {
      value: savedCrypto,
      writable: true,
      configurable: true,
    });
  });

  it("throws a meaningful error when crypto.subtle is undefined", async () => {
    savedCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: undefined },
      writable: true,
      configurable: true,
    });

    // Should throw some kind of error — verify it's not a silent failure
    await expect(sha256("test")).rejects.toThrow();
  });

  it("throws when globalThis.crypto is undefined", async () => {
    savedCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    await expect(sha256("test")).rejects.toThrow();
  });

  it("throws when crypto.subtle.digest is not a function", async () => {
    savedCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { digest: "not a function" } },
      writable: true,
      configurable: true,
    });

    await expect(sha256("test")).rejects.toThrow();
  });
});

// ── 4. Concurrent Hashing ────────────────────────────────────────────────────

describe("concurrent hashing", () => {
  it("100 concurrent sha256 calls all produce correct results", async () => {
    const inputs = Array.from({ length: 100 }, (_, i) => `input-${i}`);
    const expected = inputs.map(nodeSha256);

    const results = await Promise.all(inputs.map(sha256));

    for (let i = 0; i < 100; i++) {
      expect(results[i]).toBe(expected[i]);
    }
  });

  it("concurrent calls with identical inputs produce identical results", async () => {
    const input = "concurrent-same";
    const results = await Promise.all(Array.from({ length: 50 }, () => sha256(input)));
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect(results[0]).toBe(nodeSha256(input));
  });

  it("concurrent calls with different-length inputs", async () => {
    const inputs = Array.from({ length: 50 }, (_, i) => "x".repeat(i * 100));
    const expected = inputs.map(nodeSha256);
    const results = await Promise.all(inputs.map(sha256));

    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(expected[i]);
    }
  });
});

// ── 5. Migration Checksum Stability ──────────────────────────────────────────

describe("migration checksum stability", () => {
  it("checksum format matches migration runner expectations (64-char hex)", async () => {
    // Migration runners store checksums as VARCHAR(64)
    const sql = "CREATE TABLE users (id INT PRIMARY KEY)";
    const hash = await sha256(sql);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same migration SQL always produces the same checksum", async () => {
    const sql = `version:001\ndescription:init\nup:CREATE TABLE t (id INT)\ndown:DROP TABLE t`;
    const h1 = await sha256(sql);
    const h2 = await sha256(sql);
    expect(h1).toBe(h2);
  });

  it("checksum differs when migration SQL changes", async () => {
    const v1 = await sha256(`version:001\ndescription:init\nup:CREATE TABLE t (id INT)\ndown:DROP TABLE t`);
    const v2 = await sha256(`version:001\ndescription:init\nup:CREATE TABLE t (id BIGINT)\ndown:DROP TABLE t`);
    expect(v1).not.toBe(v2);
  });

  it("checksum differs when description changes", async () => {
    const v1 = await sha256(`version:001\ndescription:init\nup:CREATE TABLE t (id INT)\ndown:DROP TABLE t`);
    const v2 = await sha256(`version:001\ndescription:initialize\nup:CREATE TABLE t (id INT)\ndown:DROP TABLE t`);
    expect(v1).not.toBe(v2);
  });

  it("checksum differs when version changes", async () => {
    const v1 = await sha256(`version:001\ndescription:init\nup:CREATE TABLE t (id INT)\ndown:DROP TABLE t`);
    const v2 = await sha256(`version:002\ndescription:init\nup:CREATE TABLE t (id INT)\ndown:DROP TABLE t`);
    expect(v1).not.toBe(v2);
  });

  it("Web Crypto sha256 matches Node crypto for migration runner checksum format", async () => {
    // This is the exact format used by computeChecksum in pg-migration-runner.ts and sqlite-migration-runner.ts
    const content = `version:001\ndescription:Create users table\nup:CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)\ndown:DROP TABLE users`;
    const webResult = await sha256(content);
    const nodeResult = nodeSha256(content);
    expect(webResult).toBe(nodeResult);
  });

  it("multi-statement migration checksum is stable", async () => {
    const statements = ["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)", "CREATE INDEX idx_a ON a (id)"];
    const content = `version:003\ndescription:multi\nup:${statements.join("\n")}\ndown:DROP TABLE b; DROP TABLE a`;
    const h1 = await sha256(content);
    const h2 = await sha256(content);
    expect(h1).toBe(h2);
    expect(h1).toBe(nodeSha256(content));
  });
});

// ── 6. Edge Case Inputs ──────────────────────────────────────────────────────

describe("edge case inputs", () => {
  it("extremely long repeated pattern", async () => {
    const input = "SELECT 1;\n".repeat(100_000);
    const result = await sha256(input);
    expect(result).toHaveLength(64);
    expect(result).toBe(nodeSha256(input));
  });

  it("string with surrogate pairs (astral plane)", async () => {
    // 𝕳𝖊𝖑𝖑𝖔 — Mathematical Fraktur
    const input = "\uD835\uDD73\uD835\uDD8A\uD835\uDD91\uD835\uDD91\uD835\uDD94";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("string with BOM (byte order mark)", async () => {
    const input = "\uFEFFhello";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("string with zero-width characters", async () => {
    const input = "a\u200Bb\u200Cc\u200Dd\uFEFF";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("very short strings (1 char)", async () => {
    for (const ch of ["0", "a", "Z", " ", "\n"]) {
      const result = await sha256(ch);
      expect(result).toBe(nodeSha256(ch));
    }
  });

  it("string containing only newlines", async () => {
    const input = "\n\n\n\n\n";
    const result = await sha256(input);
    expect(result).toBe(nodeSha256(input));
  });

  it("string is not modified by sha256 (no side effects)", async () => {
    const input = "immutable";
    const copy = input;
    await sha256(input);
    expect(input).toBe(copy);
  });
});

// ── 7. No node:crypto Leakage in crypto-utils.ts ─────────────────────────────

describe("no node:crypto leakage in crypto-utils source", () => {
  it("crypto-utils.ts does not import from node:crypto", async () => {
    // Read the source file and verify no node:crypto imports
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../crypto-utils.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("node:crypto");
    expect(source).not.toContain("require('crypto')");
    expect(source).not.toContain('require("crypto")');
    expect(source).not.toContain("from 'crypto'");
    expect(source).not.toContain('from "crypto"');
  });

  it("crypto-utils.ts uses globalThis.crypto.subtle", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../crypto-utils.ts", import.meta.url), "utf-8");
    expect(source).toContain("globalThis.crypto.subtle");
  });
});

// ── 8. Return Type Validation ────────────────────────────────────────────────

describe("return type validation", () => {
  it("sha256 returns a Promise<string>", async () => {
    const result = sha256("test");
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(typeof resolved).toBe("string");
  });

  it("sha256 never returns undefined or null", async () => {
    const result = await sha256("test");
    expect(result).not.toBeUndefined();
    expect(result).not.toBeNull();
  });

  it("sha256 returns consistent length regardless of input length", async () => {
    const lengths = [0, 1, 10, 100, 1000, 10000];
    for (const len of lengths) {
      const result = await sha256("x".repeat(len));
      expect(result).toHaveLength(64);
    }
  });
});
