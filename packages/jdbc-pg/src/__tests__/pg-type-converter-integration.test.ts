import { describe, it, expect, vi } from "vitest";
import {
  DefaultTypeConverterRegistry,
  JsonConverter,
  BooleanConverter,
} from "espalier-jdbc";

// Mock pg module
vi.mock("pg", () => {
  return {
    Pool: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(),
        release: vi.fn(),
      }),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    })),
  };
});

import { PgDataSource } from "../pg-data-source.js";
import { PgConnection } from "../pg-connection.js";

describe("PgDataSource + TypeConverterRegistry integration", () => {
  it("PgDataSource created with a registry passes it to PgConnection", async () => {
    const registry = new DefaultTypeConverterRegistry();
    registry.register(new JsonConverter());
    registry.register(new BooleanConverter());

    const ds = new PgDataSource({
      pg: { host: "localhost" },
      typeConverters: registry,
    });

    const conn = await ds.getConnection();
    expect(conn).toBeInstanceOf(PgConnection);

    const pgConn = conn as PgConnection;
    const connRegistry = pgConn.getTypeConverterRegistry();
    expect(connRegistry).toBe(registry);
    expect(connRegistry!.get("json")).toBeInstanceOf(JsonConverter);
    expect(connRegistry!.get("boolean")).toBeInstanceOf(BooleanConverter);
    expect(connRegistry!.getAll()).toHaveLength(2);

    await conn.close();
    await ds.close();
  });

  it("PgConnection without registry returns undefined", async () => {
    const ds = new PgDataSource({ pg: { host: "localhost" } });

    const conn = await ds.getConnection();
    const pgConn = conn as PgConnection;
    expect(pgConn.getTypeConverterRegistry()).toBeUndefined();

    await conn.close();
    await ds.close();
  });

  it("PgDataSource with raw PoolConfig (no typeConverters) produces connection without registry", async () => {
    const ds = new PgDataSource({ host: "localhost" } as Record<string, unknown>);

    const conn = await ds.getConnection();
    const pgConn = conn as PgConnection;
    expect(pgConn.getTypeConverterRegistry()).toBeUndefined();

    await conn.close();
    await ds.close();
  });
});
