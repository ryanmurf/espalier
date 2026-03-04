/**
 * Adversarial E2E tests for database tracing instrumentation (Y3 Q3).
 *
 * Tests query/statement spans (#13), connection/transaction spans (#15),
 * and edge cases like error recording, span lifecycle, sensitive data
 * in spans, and noop overhead.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  setGlobalTracerProvider,
  getGlobalTracerProvider,
  NoopTracerProvider,
  SpanKind,
  SpanStatusCode,
  DbAttributes,
  IsolationLevel,
} from "espalier-jdbc";
import type {
  Span,
  Tracer,
  TracerProvider,
  SpanEvent,
  SpanAttributeValue,
  SpanStatus,
  SpanOptions,
} from "espalier-jdbc";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

// ══════════════════════════════════════════════════
// Recording tracer
// ══════════════════════════════════════════════════

class RecordingSpan implements Span {
  readonly spanName: string;
  readonly kind: SpanKind;
  readonly attributes: Record<string, SpanAttributeValue> = {};
  readonly events: SpanEvent[] = [];
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  ended = false;

  constructor(name: string, options?: SpanOptions) {
    this.spanName = name;
    this.kind = options?.kind ?? SpanKind.INTERNAL;
    if (options?.attributes) {
      Object.assign(this.attributes, options.attributes);
    }
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    this.attributes[key] = value;
  }

  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void {
    this.events.push({ name, timestamp: Date.now(), attributes });
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }

  end(): void {
    this.ended = true;
  }
}

class RecordingTracer implements Tracer {
  readonly spans: RecordingSpan[] = [];

  startSpan(name: string, options?: SpanOptions): Span {
    const span = new RecordingSpan(name, options);
    this.spans.push(span);
    return span;
  }

  clear(): void {
    this.spans.length = 0;
  }
}

class RecordingTracerProvider implements TracerProvider {
  readonly tracers = new Map<string, RecordingTracer>();

  getTracer(name: string, _version?: string): Tracer {
    if (!this.tracers.has(name)) {
      this.tracers.set(name, new RecordingTracer());
    }
    return this.tracers.get(name)!;
  }

  getSpans(tracerName = "espalier-jdbc-pg"): RecordingSpan[] {
    return this.tracers.get(tracerName)?.spans ?? [];
  }

  clear(): void {
    for (const tracer of this.tracers.values()) {
      tracer.clear();
    }
  }
}

describe.skipIf(!canConnect)("E2E: Database Tracing Instrumentation", { timeout: 30000 }, () => {
  let ds: PgDataSource;
  let provider: RecordingTracerProvider;

  const TABLE = "trace_test_items";
  const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL, value INT)`;
  const DROP = `DROP TABLE IF EXISTS ${TABLE} CASCADE`;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(DROP);
      await stmt.executeUpdate(CREATE);
    } finally {
      await stmt.close();
      await conn.close();
    }
  });

  afterAll(async () => {
    setGlobalTracerProvider(new NoopTracerProvider());
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(DROP);
    } finally {
      await stmt.close();
      await conn.close();
    }
    await ds.close();
  });

  beforeEach(() => {
    provider = new RecordingTracerProvider();
    setGlobalTracerProvider(provider);
  });

  // ══════════════════════════════════════════════════
  // Section 1: Query instrumentation spans
  // ══════════════════════════════════════════════════

  describe("query instrumentation", () => {
    it("executeQuery creates a db.query span", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery("SELECT 1 AS val");
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      expect(querySpans.length).toBeGreaterThanOrEqual(1);

      const span = querySpans[querySpans.length - 1];
      expect(span.attributes[DbAttributes.SYSTEM]).toBe("postgresql");
      expect(span.attributes[DbAttributes.STATEMENT]).toContain("SELECT 1");
      expect(span.attributes[DbAttributes.OPERATION]).toBe("SELECT");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.ended).toBe(true);
    });

    it("executeUpdate creates a span with rows_affected", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`INSERT INTO ${TABLE} (name, value) VALUES ('traced', 42)`);
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      const insertSpan = querySpans.find(s =>
        (s.attributes[DbAttributes.OPERATION] as string) === "INSERT"
      );
      expect(insertSpan).toBeDefined();
      expect(insertSpan!.attributes[DbAttributes.ROWS_AFFECTED]).toBe(1);
      expect(insertSpan!.status.code).toBe(SpanStatusCode.OK);
    });

    it("failed query records ERROR status and exception event", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery("SELECT * FROM nonexistent_table_xyz");
        expect.fail("should throw");
      } catch {
        // expected
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      const errorSpan = querySpans.find(s => s.status.code === SpanStatusCode.ERROR);
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.ended).toBe(true);

      // Should have an exception event
      const exceptionEvent = errorSpan!.events.find(e => e.name === "exception");
      expect(exceptionEvent).toBeDefined();
      expect(exceptionEvent!.attributes!["exception.type"]).toBeDefined();
      expect(exceptionEvent!.attributes!["exception.message"]).toBeDefined();
    });

    it("prepared statement creates a span", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.prepareStatement(`SELECT * FROM ${TABLE} WHERE name = $1`);
      try {
        stmt.setParameter(1, "traced");
        await stmt.executeQuery();
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      const selectSpan = querySpans.find(s =>
        String(s.attributes[DbAttributes.STATEMENT] ?? "").includes("$1")
      );
      expect(selectSpan).toBeDefined();
      expect(selectSpan!.attributes[DbAttributes.OPERATION]).toBe("SELECT");
    });

    it("span records SQL operation type correctly", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`UPDATE ${TABLE} SET value = 99 WHERE name = 'traced'`);
        await stmt.executeUpdate(`DELETE FROM ${TABLE} WHERE name = 'traced'`);
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      const updateSpan = querySpans.find(s => s.attributes[DbAttributes.OPERATION] === "UPDATE");
      const deleteSpan = querySpans.find(s => s.attributes[DbAttributes.OPERATION] === "DELETE");
      expect(updateSpan).toBeDefined();
      expect(deleteSpan).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Connection acquire spans
  // ══════════════════════════════════════════════════

  describe("connection acquire spans", () => {
    it("getConnection creates a db.connection.acquire span", async () => {
      const conn = await ds.getConnection();
      await conn.close();

      const acquireSpans = provider.getSpans().filter(s => s.spanName === "db.connection.acquire");
      expect(acquireSpans.length).toBeGreaterThanOrEqual(1);

      const span = acquireSpans[0];
      expect(span.attributes[DbAttributes.SYSTEM]).toBe("postgresql");
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.ended).toBe(true);
    });

    it("acquire span records pool stats", async () => {
      const conn = await ds.getConnection();
      await conn.close();

      const acquireSpans = provider.getSpans().filter(s => s.spanName === "db.connection.acquire");
      const span = acquireSpans[0];
      expect(span.attributes["db.pool.total"]).toBeDefined();
      expect(span.attributes["db.pool.idle"]).toBeDefined();
      expect(span.attributes["db.pool.acquire_time_ms"]).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Transaction tracing spans
  // ══════════════════════════════════════════════════

  describe("transaction tracing", () => {
    it("beginTransaction creates a db.transaction span", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        await tx.commit();
      } finally {
        await conn.close();
      }

      const txSpans = provider.getSpans().filter(s => s.spanName === "db.transaction");
      expect(txSpans.length).toBeGreaterThanOrEqual(1);

      const span = txSpans[0];
      expect(span.attributes[DbAttributes.SYSTEM]).toBe("postgresql");
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.ended).toBe(true);
    });

    it("commit records outcome=commit and OK status", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        await tx.commit();
      } finally {
        await conn.close();
      }

      const txSpan = provider.getSpans().find(s => s.spanName === "db.transaction");
      expect(txSpan).toBeDefined();
      expect(txSpan!.attributes["db.transaction.outcome"]).toBe("commit");
      expect(txSpan!.status.code).toBe(SpanStatusCode.OK);
    });

    it("rollback records outcome=rollback and OK status", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        await tx.rollback();
      } finally {
        await conn.close();
      }

      const txSpan = provider.getSpans().find(s => s.spanName === "db.transaction");
      expect(txSpan).toBeDefined();
      expect(txSpan!.attributes["db.transaction.outcome"]).toBe("rollback");
      expect(txSpan!.status.code).toBe(SpanStatusCode.OK);
    });

    it("transaction with isolation level records it", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
        await tx.commit();
      } finally {
        await conn.close();
      }

      const txSpan = provider.getSpans().find(s => s.spanName === "db.transaction");
      expect(txSpan).toBeDefined();
      expect(txSpan!.attributes["db.transaction.isolation"]).toBe(IsolationLevel.SERIALIZABLE);
    });

    it("savepoint events are recorded on the transaction span", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        await tx.setSavepoint("sp1");
        await tx.rollbackTo("sp1");
        await tx.commit();
      } finally {
        await conn.close();
      }

      const txSpan = provider.getSpans().find(s => s.spanName === "db.transaction");
      expect(txSpan).toBeDefined();

      const savepointEvent = txSpan!.events.find(e => e.name === "savepoint");
      expect(savepointEvent).toBeDefined();
      expect(savepointEvent!.attributes!["db.savepoint.name"]).toBe("sp1");

      const rollbackEvent = txSpan!.events.find(e => e.name === "rollback_to_savepoint");
      expect(rollbackEvent).toBeDefined();
      expect(rollbackEvent!.attributes!["db.savepoint.name"]).toBe("sp1");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: SQL truncation and sensitive data
  // ══════════════════════════════════════════════════

  describe("sensitive data handling", () => {
    it("long SQL is truncated in span attributes", async () => {
      const longSql = `SELECT * FROM ${TABLE} WHERE name = '${"x".repeat(500)}'`;
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery(longSql);
      } catch {
        // May fail, but span should still be created
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      const lastSpan = querySpans[querySpans.length - 1];
      const recorded = String(lastSpan?.attributes[DbAttributes.STATEMENT] ?? "");
      // Should be truncated
      expect(recorded.length).toBeLessThanOrEqual(210); // 200 + "..."
    });

    it("BUG POTENTIAL: SQL with credentials in span", async () => {
      // If someone writes SQL with embedded credentials (bad practice but possible),
      // the span records it. traceQuery truncates to 200 chars but doesn't redact.
      const sensitiveSQL = `SELECT * FROM ${TABLE} WHERE name = 'password=s3cret&key=abc123'`;
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery(sensitiveSQL);
      } finally {
        await stmt.close();
        await conn.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      const lastSpan = querySpans[querySpans.length - 1];
      const recorded = String(lastSpan?.attributes[DbAttributes.STATEMENT] ?? "");
      // The credential is present in the span — no automatic redaction
      expect(recorded).toContain("s3cret");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Noop provider overhead
  // ══════════════════════════════════════════════════

  describe("noop provider", () => {
    it("operations work with NoopTracerProvider", async () => {
      setGlobalTracerProvider(new NoopTracerProvider());

      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`INSERT INTO ${TABLE} (name, value) VALUES ('noop', 1)`);
        const rs = await stmt.executeQuery(`SELECT * FROM ${TABLE} WHERE name = 'noop'`);
        expect(await rs.next()).toBe(true);
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    it("transaction works with NoopTracerProvider", async () => {
      setGlobalTracerProvider(new NoopTracerProvider());

      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        const stmt = conn.createStatement();
        await stmt.executeUpdate(`DELETE FROM ${TABLE} WHERE name = 'noop'`);
        await stmt.close();
        await tx.commit();
      } finally {
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("span ends even when query throws", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery("INVALID SQL GARBAGE");
      } catch {
        // expected
      } finally {
        await stmt.close();
        await conn.close();
      }

      // All spans should be ended
      for (const span of provider.getSpans().filter(s => s.spanName === "db.query")) {
        expect(span.ended, `Span "${span.spanName}" was not ended`).toBe(true);
      }
    });

    it("concurrent queries create independent spans", async () => {
      const conn1 = await ds.getConnection();
      const conn2 = await ds.getConnection();
      const stmt1 = conn1.createStatement();
      const stmt2 = conn2.createStatement();

      try {
        await Promise.all([
          stmt1.executeQuery("SELECT 1"),
          stmt2.executeQuery("SELECT 2"),
        ]);
      } finally {
        await stmt1.close();
        await stmt2.close();
        await conn1.close();
        await conn2.close();
      }

      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      // At least 2 query spans
      expect(querySpans.length).toBeGreaterThanOrEqual(2);

      // Each should be independent (different instances)
      const uniqueSpans = new Set(querySpans);
      expect(uniqueSpans.size).toBe(querySpans.length);
    });

    it("provider swap mid-operation — new spans go to new provider", async () => {
      // Start with recording provider
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery("SELECT 1");
      } finally {
        await stmt.close();
        await conn.close();
      }

      const firstProviderSpans = provider.getSpans().length;
      expect(firstProviderSpans).toBeGreaterThan(0);

      // Swap provider
      const newProvider = new RecordingTracerProvider();
      setGlobalTracerProvider(newProvider);

      const conn2 = await ds.getConnection();
      const stmt2 = conn2.createStatement();
      try {
        await stmt2.executeQuery("SELECT 2");
      } finally {
        await stmt2.close();
        await conn2.close();
      }

      // New provider should have spans, old provider unchanged
      expect(newProvider.getSpans().length).toBeGreaterThan(0);
      expect(provider.getSpans().length).toBe(firstProviderSpans);
    });

    it("empty SQL is traced without crash", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeQuery("");
      } catch {
        // PG will reject empty SQL, but tracing shouldn't crash
      } finally {
        await stmt.close();
        await conn.close();
      }

      // Span should exist and be ended (even if error)
      const querySpans = provider.getSpans().filter(s => s.spanName === "db.query");
      expect(querySpans.length).toBeGreaterThanOrEqual(1);
      expect(querySpans[querySpans.length - 1].ended).toBe(true);
    });
  });
});
