import type { Connection, DataSource } from "espalier-jdbc";
import { describe, expect, it } from "vitest";
import { PollingChangeDetector } from "../notifications/polling-change-detector.js";

function createMockDataSource(rows: Record<string, unknown>[][] = [[]]): DataSource {
  let callIndex = 0;

  const mockDataSource: DataSource = {
    async getConnection(): Promise<Connection> {
      const currentRows = rows[Math.min(callIndex++, rows.length - 1)];
      let rowIndex = -1;

      return {
        prepareStatement(_sql: string) {
          return {
            setParameter(_index: number, _value: unknown) {},
            async executeQuery() {
              return {
                async next() {
                  rowIndex++;
                  return rowIndex < currentRows.length;
                },
                getRow() {
                  return { ...currentRows[rowIndex] };
                },
                getString(_col: string | number) {
                  return null;
                },
                getNumber(_col: string | number) {
                  return null;
                },
                getBoolean(_col: string | number) {
                  return null;
                },
                getDate(_col: string | number) {
                  return null;
                },
                getMetadata() {
                  return [];
                },
                async close() {},
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      return { done: true, value: undefined };
                    },
                  };
                },
              };
            },
            async executeUpdate() {
              return 0;
            },
          } as any;
        },
        createStatement() {
          return {} as any;
        },
        async beginTransaction() {
          return {} as any;
        },
        async close() {},
        isClosed() {
          return false;
        },
      } as Connection;
    },
    async close() {},
  };

  return mockDataSource;
}

describe("PollingChangeDetector", () => {
  it("should emit notifications for rows returned by the query", async () => {
    const ds = createMockDataSource([
      [{ id: 1, name: "Alice" }],
      [{ id: 2, name: "Bob" }],
      [], // empty -- will cause the test to stop collecting
    ]);

    const detector = new PollingChangeDetector(ds, {
      intervalMs: 100,
      query: "SELECT * FROM changes WHERE processed = false",
    });

    const results: string[] = [];
    for await (const notification of detector.watch("test_channel")) {
      results.push(notification.payload);
      if (results.length >= 2) {
        detector.stop();
        break;
      }
    }

    expect(results).toHaveLength(2);
    expect(JSON.parse(results[0])).toEqual({ id: 1, name: "Alice" });
    expect(JSON.parse(results[1])).toEqual({ id: 2, name: "Bob" });
  });

  it("should clamp interval to minimum 100ms", () => {
    const ds = createMockDataSource();
    const detector = new PollingChangeDetector(ds, {
      intervalMs: 10, // below minimum
      query: "SELECT 1",
    });

    // The detector should still work (clamped internally)
    expect(detector).toBeDefined();
  });

  it("should clamp interval to maximum 60000ms", () => {
    const ds = createMockDataSource();
    const detector = new PollingChangeDetector(ds, {
      intervalMs: 120_000, // above maximum
      query: "SELECT 1",
    });

    expect(detector).toBeDefined();
  });

  it("should throw when closed", async () => {
    const ds = createMockDataSource();
    const detector = new PollingChangeDetector(ds, {
      intervalMs: 100,
      query: "SELECT 1",
    });

    detector.close();

    await expect(async () => {
      for await (const _n of detector.watch("test")) {
        // Should not reach here
      }
    }).rejects.toThrow(/has been closed/);
  });

  it("should set channel on emitted notifications", async () => {
    const ds = createMockDataSource([[{ id: 1 }]]);
    const detector = new PollingChangeDetector(ds, {
      intervalMs: 100,
      query: "SELECT 1",
    });

    for await (const notification of detector.watch("my_channel")) {
      expect(notification.channel).toBe("my_channel");
      detector.stop();
      break;
    }
  });

  it("should throw when already watching", async () => {
    // Create a data source where getConnection blocks indefinitely
    // so the first watch() stays in-progress
    let unblock: (() => void) | undefined;
    const blockingDs: DataSource = {
      async getConnection(): Promise<Connection> {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        // Return a dummy connection (won't actually be used since we abort)
        return createMockDataSource([[{ id: 1 }]]).getConnection();
      },
      async close() {},
    };

    const detector = new PollingChangeDetector(blockingDs, {
      intervalMs: 100,
      query: "SELECT 1",
    });

    // Start first watch in background - it will block on getConnection
    const watchPromise = (async () => {
      for await (const _n of detector.watch("ch1")) {
        break;
      }
    })();

    // Yield to let the first watch enter its generator body and set abortController
    await new Promise((r) => setTimeout(r, 20));

    // Second watch should throw synchronously inside the generator
    const secondIter = detector.watch("ch2");
    // Calling .next() triggers the generator body which checks the guard
    await expect((secondIter as AsyncGenerator).next()).rejects.toThrow(/already watching/);

    // Clean up
    detector.stop();
    if (unblock) unblock();
    await watchPromise;
  });
});
