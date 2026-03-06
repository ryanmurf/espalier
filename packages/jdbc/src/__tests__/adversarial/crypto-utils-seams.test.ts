/**
 * Adversarial regression tests for Web Crypto sha256 seams.
 *
 * Tests the boundary between the new Web Crypto sha256 and existing migration
 * checksum logic:
 * - Produces correct SHA-256 hashes
 * - Matches expected hex encoding
 * - Handles empty strings, unicode, large inputs
 * - Works with existing migration checksum format
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "../../crypto-utils.js";

describe("sha256 Web Crypto seam tests", () => {
  // Known SHA-256 test vectors
  it("produces correct hash for empty string", async () => {
    const hash = await sha256("");
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("produces correct hash for 'hello'", async () => {
    const hash = await sha256("hello");
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("produces correct hash for 'abc'", async () => {
    const hash = await sha256("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("returns lowercase hex string", async () => {
    const hash = await sha256("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("always returns exactly 64 hex characters", async () => {
    const inputs = ["", "a", "hello world", "x".repeat(10000)];
    for (const input of inputs) {
      const hash = await sha256(input);
      expect(hash.length).toBe(64);
    }
  });

  it("different inputs produce different hashes", async () => {
    const h1 = await sha256("input1");
    const h2 = await sha256("input2");
    expect(h1).not.toBe(h2);
  });

  it("same input produces same hash (deterministic)", async () => {
    const h1 = await sha256("deterministic");
    const h2 = await sha256("deterministic");
    expect(h1).toBe(h2);
  });

  it("handles unicode characters correctly", async () => {
    const hash = await sha256("\u00e9\u00e0\u00fc\u00f1\u00f6");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Must be stable
    const hash2 = await sha256("\u00e9\u00e0\u00fc\u00f1\u00f6");
    expect(hash).toBe(hash2);
  });

  it("handles emoji", async () => {
    const hash = await sha256("\u{1F600}\u{1F680}\u{1F4A5}");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles null characters in string", async () => {
    const hash = await sha256("before\0after");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Should differ from the string without null
    const hashNoNull = await sha256("beforeafter");
    expect(hash).not.toBe(hashNoNull);
  });

  it("handles very long strings without error", async () => {
    const longStr = "x".repeat(1_000_000);
    const hash = await sha256(longStr);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles newlines consistently (migration checksum format)", async () => {
    // Migration checksums include newlines in the content format
    const content = "version:001\ndescription:test\nup:CREATE TABLE t(id INT)\ndown:DROP TABLE t";
    const hash = await sha256(content);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Must be stable
    const hash2 = await sha256(content);
    expect(hash).toBe(hash2);
  });

  it("CRLF and LF produce different hashes", async () => {
    const lf = await sha256("line1\nline2");
    const crlf = await sha256("line1\r\nline2");
    expect(lf).not.toBe(crlf);
  });

  it("whitespace-only strings are valid inputs", async () => {
    const h1 = await sha256(" ");
    const h2 = await sha256("  ");
    const h3 = await sha256("\t");
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
