/**
 * Adversarial E2E tests for repository-level tracing spans (Y3 Q3).
 *
 * Verifies that CrudRepository methods create repository.{operation} spans
 * with correct entity type, operation, and status attributes.
 */

import { Column, createRepository, getEntityMetadata, Id, Table } from "espalier-data";
import type {
  Span,
  SpanAttributeValue,
  SpanEvent,
  SpanOptions,
  SpanStatus,
  Tracer,
  TracerProvider,
} from "espalier-jdbc";
import { NoopTracerProvider, SpanKind, SpanStatusCode, setGlobalTracerProvider } from "espalier-jdbc";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

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

  getSpans(tracerName?: string): RecordingSpan[] {
    const spans: RecordingSpan[] = [];
    if (tracerName) {
      return this.tracers.get(tracerName)?.spans ?? [];
    }
    for (const t of this.tracers.values()) {
      spans.push(...t.spans);
    }
    return spans;
  }

  clear(): void {
    for (const t of this.tracers.values()) {
      t.clear();
    }
  }
}

// ══════════════════════════════════════════════════
// Test entity
// ══════════════════════════════════════════════════

@Table("repo_trace_items")
class RtItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column({ type: "INT" }) value!: number;
}
new RtItem();
getEntityMetadata(RtItem);

describe.skipIf(!canConnect)("E2E: Repository-level tracing spans", { timeout: 30000 }, () => {
  let ds: PgDataSource;
  let provider: RecordingTracerProvider;

  const CREATE = `
    CREATE TABLE IF NOT EXISTS repo_trace_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INT NOT NULL DEFAULT 0
    )
  `;
  const DROP = "DROP TABLE IF EXISTS repo_trace_items CASCADE";

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

  beforeEach(async () => {
    provider = new RecordingTracerProvider();
    setGlobalTracerProvider(provider);

    // Clear table
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate("DELETE FROM repo_trace_items");
    } finally {
      await stmt.close();
      await conn.close();
    }
    provider.clear();
  });

  // ══════════════════════════════════════════════════
  // Section 1: CRUD operation spans
  // ══════════════════════════════════════════════════

  describe("CRUD operation spans", () => {
    it("save() creates a repository.save span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "traced-save";
      item.value = 1;
      await repo.save(item);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.save");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);

      const span = repoSpans[0];
      expect(span.attributes["repository.entity"]).toBe("RtItem");
      expect(span.attributes["repository.operation"]).toBe("save");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.ended).toBe(true);
    });

    it("findById() creates a repository.findById span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "find-me";
      item.value = 2;
      const saved = await repo.save(item);
      provider.clear();

      await repo.findById(saved.id);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.findById");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
      expect(repoSpans[0].attributes["repository.operation"]).toBe("findById");
      expect(repoSpans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it("findAll() creates a repository.findAll span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "all-test";
      item.value = 3;
      await repo.save(item);
      provider.clear();

      await repo.findAll();

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.findAll");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
      expect(repoSpans[0].attributes["repository.entity"]).toBe("RtItem");
    });

    it("delete() creates a repository.delete span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "delete-me";
      item.value = 4;
      const saved = await repo.save(item);
      provider.clear();

      await repo.delete(saved);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.delete");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
      expect(repoSpans[0].attributes["repository.operation"]).toBe("delete");
      expect(repoSpans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it("count() creates a repository.count span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      await repo.count();

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.count");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
    });

    it("existsById() creates a repository.existsById span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "exists-test";
      item.value = 5;
      const saved = await repo.save(item);
      provider.clear();

      await repo.existsById(saved.id);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.existsById");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteById() creates a repository.deleteById span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "delete-by-id";
      item.value = 6;
      const saved = await repo.save(item);
      provider.clear();

      await repo.deleteById(saved.id);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.deleteById");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Span attributes
  // ══════════════════════════════════════════════════

  describe("span attributes", () => {
    it("entity name appears in span attributes", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);
      await repo.findAll();

      const span = provider.getSpans("espalier-data").find((s) => s.spanName.startsWith("repository."));
      expect(span).toBeDefined();
      expect(span!.attributes["repository.entity"]).toBe("RtItem");
    });

    it("span kind is INTERNAL (not CLIENT)", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);
      await repo.findAll();

      const span = provider.getSpans("espalier-data").find((s) => s.spanName.startsWith("repository."));
      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.INTERNAL);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Error spans
  // ══════════════════════════════════════════════════

  describe("error spans", () => {
    it("error in save() produces ERROR status span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      // Try saving with a null name (NOT NULL constraint)
      const item = new RtItem();
      (item as any).name = null;
      item.value = 99;

      try {
        await repo.save(item);
      } catch {
        // expected
      }

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.save");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);

      const errorSpan = repoSpans.find((s) => s.status.code === SpanStatusCode.ERROR);
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.ended).toBe(true);
      expect(errorSpan!.status.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Noop provider
  // ══════════════════════════════════════════════════

  describe("noop provider", () => {
    it("all operations work with NoopTracerProvider", async () => {
      setGlobalTracerProvider(new NoopTracerProvider());
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "noop-test";
      item.value = 10;
      const saved = await repo.save(item);
      expect(saved.id).toBeGreaterThan(0);

      const found = await repo.findById(saved.id);
      expect(found).toBeDefined();

      const all = await repo.findAll();
      expect(all.length).toBeGreaterThanOrEqual(1);

      const exists = await repo.existsById(saved.id);
      expect(exists).toBe(true);

      const cnt = await repo.count();
      expect(cnt).toBeGreaterThanOrEqual(1);

      await repo.deleteById(saved.id);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Span hierarchy
  // ══════════════════════════════════════════════════

  describe("span hierarchy", () => {
    it("save() triggers both repository and query spans", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "hierarchy-test";
      item.value = 7;
      await repo.save(item);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName.startsWith("repository."));
      const querySpans = provider.getSpans("espalier-jdbc-pg").filter((s) => s.spanName === "db.query");

      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
      expect(querySpans.length).toBeGreaterThanOrEqual(1);
    });

    it("findAll creates both repository and query spans", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);
      await repo.findAll();

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.findAll");
      const querySpans = provider.getSpans("espalier-jdbc-pg").filter((s) => s.spanName === "db.query");

      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
      expect(querySpans.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("saveAll creates a span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const items = Array.from({ length: 3 }, (_, i) => {
        const it = new RtItem();
        it.name = `batch-${i}`;
        it.value = i;
        return it;
      });
      await repo.saveAll(items);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.saveAll");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteAll creates a span", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      const item = new RtItem();
      item.name = "delete-all";
      item.value = 8;
      const saved = await repo.save(item);
      provider.clear();

      await repo.deleteAll([saved]);

      const repoSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.deleteAll");
      expect(repoSpans.length).toBeGreaterThanOrEqual(1);
    });

    it("multiple rapid operations create distinct spans", async () => {
      const repo = createRepository<RtItem, number>(RtItem, ds);

      for (let i = 0; i < 5; i++) {
        const it = new RtItem();
        it.name = `rapid-${i}`;
        it.value = i;
        await repo.save(it);
      }

      const saveSpans = provider.getSpans("espalier-data").filter((s) => s.spanName === "repository.save");
      expect(saveSpans.length).toBeGreaterThanOrEqual(5);

      // All should be ended
      for (const s of saveSpans) {
        expect(s.ended).toBe(true);
      }
    });
  });
});
