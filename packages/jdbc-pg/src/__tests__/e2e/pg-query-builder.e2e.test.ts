import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Connection } from "espalier-jdbc";
import {
  QueryBuilder,
  col,
  and,
  or,
  not,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import {
  createTestDataSource,
  isPostgresAvailable,
  dropTestTable,
} from "./setup.js";

const TABLE = "e2e_query_builder";
const canConnect = await isPostgresAvailable();

const SEED_ROWS = [
  { name: "Alice", email: "alice@example.com", age: 30, active: true },
  { name: "Bob", email: "bob@example.com", age: 25, active: true },
  { name: "Charlie", email: "charlie@example.com", age: 35, active: false },
  { name: "Diana", email: "diana@example.com", age: 28, active: true },
  { name: "Eve", email: null, age: 22, active: false },
];

describe.skipIf(!canConnect)(
  "E2E: QueryBuilder against Postgres",
  { timeout: 15000 },
  () => {
    let ds: PgDataSource;
    let conn: Connection;

    async function reseed() {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DELETE FROM ${TABLE}`);
      for (const r of SEED_ROWS) {
        const ps = conn.prepareStatement(
          `INSERT INTO ${TABLE} (name, email, age, active) VALUES ($1, $2, $3, $4)`,
        );
        ps.setParameter(1, r.name);
        ps.setParameter(2, r.email);
        ps.setParameter(3, r.age);
        ps.setParameter(4, r.active);
        await ps.executeUpdate();
      }
    }

    beforeAll(async () => {
      ds = createTestDataSource();
      conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(dropTestTable(TABLE));
      await stmt.executeUpdate(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          age INT,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    });

    beforeEach(async () => {
      await reseed();
    });

    afterAll(async () => {
      if (conn && !conn.isClosed()) {
        const stmt = conn.createStatement();
        await stmt.executeUpdate(dropTestTable(TABLE));
        await conn.close();
      }
      if (ds) {
        await ds.close();
      }
    });

    async function executeQuery(built: { sql: string; params: unknown[] }) {
      const ps = conn.prepareStatement(built.sql);
      for (let i = 0; i < built.params.length; i++) {
        ps.setParameter(i + 1, built.params[i] as any);
      }
      return ps.executeQuery();
    }

    async function executeUpdate(built: { sql: string; params: unknown[] }) {
      const ps = conn.prepareStatement(built.sql);
      for (let i = 0; i < built.params.length; i++) {
        ps.setParameter(i + 1, built.params[i] as any);
      }
      return ps.executeUpdate();
    }

    async function collectRows(built: { sql: string; params: unknown[] }) {
      const rs = await executeQuery(built);
      const rows: Record<string, unknown>[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      return rows;
    }

    describe("SelectBuilder", () => {
      it("selects all rows with no criteria", async () => {
        const query = QueryBuilder.select(TABLE).build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(5);
      });

      it("selects specific columns", async () => {
        const query = QueryBuilder.select(TABLE)
          .columns("name", "age")
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(5);
        expect(Object.keys(rows[0])).toEqual(
          expect.arrayContaining(["name", "age"]),
        );
        expect(Object.keys(rows[0])).not.toContain("email");
      });

      it("where eq criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("name").eq("Alice"))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Alice");
      });

      it("where neq criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("name").neq("Alice"))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(4);
        expect(rows.every((r) => r.name !== "Alice")).toBe(true);
      });

      it("where gt criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("age").gt(30))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Charlie");
      });

      it("where gte criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("age").gte(30))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(2);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Alice", "Charlie"]);
      });

      it("where lt criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("age").lt(25))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Eve");
      });

      it("where lte criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("age").lte(25))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(2);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Bob", "Eve"]);
      });

      it("where like criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("email").like("%@example.com"))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(4);
      });

      it("where in criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("name").in(["Alice", "Bob", "Eve"]))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(3);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Alice", "Bob", "Eve"]);
      });

      it("where between criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("age").between(25, 30))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(3);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Alice", "Bob", "Diana"]);
      });

      it("where isNull criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("email").isNull())
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Eve");
      });

      it("where isNotNull criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("email").isNotNull())
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(4);
      });

      it("AND composition via chaining", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("age").gte(25))
          .and(col("active").eq(true))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(3);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Alice", "Bob", "Diana"]);
      });

      it("OR composition via chaining", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(col("name").eq("Alice"))
          .or(col("name").eq("Eve"))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(2);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Alice", "Eve"]);
      });

      it("NOT criteria", async () => {
        const query = QueryBuilder.select(TABLE)
          .where(not(col("active").eq(true)))
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(2);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Charlie", "Eve"]);
      });

      it("complex AND/OR composition with helper functions", async () => {
        // (age > 28 AND active = true) OR name = 'Eve'
        const criteria = or(
          and(col("age").gt(28), col("active").eq(true)),
          col("name").eq("Eve"),
        );
        const query = QueryBuilder.select(TABLE).where(criteria).build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(2);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Alice", "Eve"]);
      });

      it("ORDER BY ascending", async () => {
        const query = QueryBuilder.select(TABLE)
          .columns("name", "age")
          .orderBy("age", "ASC")
          .build();
        const rows = await collectRows(query);
        const ages = rows.map((r) => r.age);
        expect(ages).toEqual([22, 25, 28, 30, 35]);
      });

      it("ORDER BY descending", async () => {
        const query = QueryBuilder.select(TABLE)
          .columns("name", "age")
          .orderBy("age", "DESC")
          .build();
        const rows = await collectRows(query);
        const ages = rows.map((r) => r.age);
        expect(ages).toEqual([35, 30, 28, 25, 22]);
      });

      it("ORDER BY multiple columns", async () => {
        const query = QueryBuilder.select(TABLE)
          .columns("name", "active", "age")
          .orderBy("active", "DESC")
          .orderBy("age", "ASC")
          .build();
        const rows = await collectRows(query);
        // active=true (true > false in pg) first, sorted by age; then active=false sorted by age
        const trueRows = rows.filter((r) => r.active === true);
        const falseRows = rows.filter((r) => r.active === false);
        expect(trueRows.map((r) => r.age)).toEqual([25, 28, 30]);
        expect(falseRows.map((r) => r.age)).toEqual([22, 35]);
      });

      it("LIMIT", async () => {
        const query = QueryBuilder.select(TABLE)
          .orderBy("age", "ASC")
          .limit(3)
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(3);
        const ages = rows.map((r) => r.age);
        expect(ages).toEqual([22, 25, 28]);
      });

      it("OFFSET", async () => {
        const query = QueryBuilder.select(TABLE)
          .orderBy("age", "ASC")
          .limit(2)
          .offset(2)
          .build();
        const rows = await collectRows(query);
        expect(rows.length).toBe(2);
        const ages = rows.map((r) => r.age);
        expect(ages).toEqual([28, 30]);
      });

      it("GROUP BY with HAVING", async () => {
        const query = QueryBuilder.select(TABLE)
          .columns("active", "COUNT(*) AS cnt")
          .groupBy("active")
          .having(col("COUNT(*)").gt(2))
          .orderBy("active", "DESC")
          .build();
        const rows = await collectRows(query);
        // active=true has 3 rows, active=false has 2
        expect(rows.length).toBe(1);
        expect(rows[0].active).toBe(true);
        expect(Number(rows[0].cnt)).toBe(3);
      });
    });

    describe("InsertBuilder", () => {
      it("inserts a row using set()", async () => {
        const query = QueryBuilder.insert(TABLE)
          .set("name", "Frank")
          .set("email", "frank@example.com")
          .set("age", 40)
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(1);

        // Verify
        const check = QueryBuilder.select(TABLE)
          .where(col("name").eq("Frank"))
          .build();
        const rows = await collectRows(check);
        expect(rows.length).toBe(1);
        expect(rows[0].age).toBe(40);
      });

      it("inserts a row using values()", async () => {
        const query = QueryBuilder.insert(TABLE)
          .values({ name: "Grace", email: "grace@example.com", age: 33 })
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(1);
      });

      it("inserts with RETURNING clause", async () => {
        const query = QueryBuilder.insert(TABLE)
          .set("name", "Hank")
          .set("email", "hank@example.com")
          .set("age", 45)
          .returning("id", "name")
          .build();
        const rs = await executeQuery(query);
        expect(await rs.next()).toBe(true);
        expect(rs.getNumber("id")).toBeGreaterThan(0);
        expect(rs.getString("name")).toBe("Hank");
      });
    });

    describe("UpdateBuilder", () => {
      it("updates rows matching criteria", async () => {
        const query = QueryBuilder.update(TABLE)
          .set("age", 31)
          .where(col("name").eq("Alice"))
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(1);

        // Verify
        const check = QueryBuilder.select(TABLE)
          .columns("age")
          .where(col("name").eq("Alice"))
          .build();
        const rows = await collectRows(check);
        expect(rows[0].age).toBe(31);
      });

      it("updates with values()", async () => {
        const query = QueryBuilder.update(TABLE)
          .values({ age: 26, active: false })
          .where(col("name").eq("Bob"))
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(1);

        const check = QueryBuilder.select(TABLE)
          .columns("age", "active")
          .where(col("name").eq("Bob"))
          .build();
        const rows = await collectRows(check);
        expect(rows[0].age).toBe(26);
        expect(rows[0].active).toBe(false);
      });

      it("updates with RETURNING clause", async () => {
        const query = QueryBuilder.update(TABLE)
          .set("age", 36)
          .where(col("name").eq("Charlie"))
          .returning("name", "age")
          .build();
        const rs = await executeQuery(query);
        expect(await rs.next()).toBe(true);
        expect(rs.getString("name")).toBe("Charlie");
        expect(rs.getNumber("age")).toBe(36);
      });

      it("updates with AND criteria", async () => {
        const query = QueryBuilder.update(TABLE)
          .set("active", true)
          .where(col("name").eq("Charlie"))
          .and(col("age").gte(35))
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(1);
      });

      it("returns 0 when no rows match", async () => {
        const query = QueryBuilder.update(TABLE)
          .set("age", 100)
          .where(col("name").eq("Nobody"))
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(0);
      });
    });

    describe("DeleteBuilder", () => {
      it("deletes rows matching criteria", async () => {
        // Insert a temp row
        const insertQuery = QueryBuilder.insert(TABLE)
          .set("name", "ToDeleteViaQB")
          .set("age", 99)
          .build();
        await executeUpdate(insertQuery);

        const deleteQuery = QueryBuilder.delete(TABLE)
          .where(col("name").eq("ToDeleteViaQB"))
          .build();
        const count = await executeUpdate(deleteQuery);
        expect(count).toBe(1);

        // Verify deleted
        const check = QueryBuilder.select(TABLE)
          .where(col("name").eq("ToDeleteViaQB"))
          .build();
        const rows = await collectRows(check);
        expect(rows.length).toBe(0);
      });

      it("deletes with RETURNING clause", async () => {
        const insertQuery = QueryBuilder.insert(TABLE)
          .set("name", "ReturnDelete")
          .set("age", 88)
          .build();
        await executeUpdate(insertQuery);

        const deleteQuery = QueryBuilder.delete(TABLE)
          .where(col("name").eq("ReturnDelete"))
          .returning("name", "age")
          .build();
        const rs = await executeQuery(deleteQuery);
        expect(await rs.next()).toBe(true);
        expect(rs.getString("name")).toBe("ReturnDelete");
        expect(rs.getNumber("age")).toBe(88);
      });

      it("deletes with AND criteria", async () => {
        const insertQuery = QueryBuilder.insert(TABLE)
          .values({ name: "MultiCritDel", age: 77, active: false })
          .build();
        await executeUpdate(insertQuery);

        const deleteQuery = QueryBuilder.delete(TABLE)
          .where(col("name").eq("MultiCritDel"))
          .and(col("active").eq(false))
          .build();
        const count = await executeUpdate(deleteQuery);
        expect(count).toBe(1);
      });

      it("returns 0 when no rows match", async () => {
        const query = QueryBuilder.delete(TABLE)
          .where(col("name").eq("Nobody"))
          .build();
        const count = await executeUpdate(query);
        expect(count).toBe(0);
      });
    });
  },
);
