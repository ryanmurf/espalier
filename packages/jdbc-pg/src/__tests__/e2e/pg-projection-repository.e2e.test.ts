import { Column, createDerivedRepository, Id, Projection, Table } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("proj_test_employees")
class ProjTestEmployee {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column("first_name") firstName!: string;
  @Column("last_name") lastName!: string;
  @Column() email!: string;
  @Column() salary!: number;
  @Column() department!: string;
}
new ProjTestEmployee();

@Projection({ entity: ProjTestEmployee })
class EmployeeSummary {
  @Column("first_name") firstName!: string;
  @Column("last_name") lastName!: string;
}
new EmployeeSummary();

@Projection({ entity: ProjTestEmployee })
class EmployeeContact {
  @Column("first_name") firstName!: string;
  @Column() email!: string;
}
new EmployeeContact();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS proj_test_employees (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    salary NUMERIC(10,2) NOT NULL,
    department TEXT NOT NULL
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS proj_test_employees CASCADE`;

describe.skipIf(!canConnect)("E2E: Projection Repository", { timeout: 15000 }, () => {
  let ds: PgDataSource;
  let repo: ReturnType<typeof createDerivedRepository<ProjTestEmployee, number>>;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    await conn.close();

    repo = createDerivedRepository<ProjTestEmployee, number>(ProjTestEmployee, ds);

    const employees = [
      { firstName: "Alice", lastName: "Smith", email: "alice@example.com", salary: 90000, department: "Engineering" },
      { firstName: "Bob", lastName: "Jones", email: "bob@example.com", salary: 85000, department: "Engineering" },
      { firstName: "Carol", lastName: "Brown", email: "carol@example.com", salary: 95000, department: "Engineering" },
      { firstName: "Dave", lastName: "Wilson", email: "dave@example.com", salary: 70000, department: "Marketing" },
      { firstName: "Eve", lastName: "Davis", email: "eve@example.com", salary: 75000, department: "Marketing" },
      { firstName: "Frank", lastName: "Taylor", email: "frank@example.com", salary: 110000, department: "Executive" },
    ];

    for (const e of employees) {
      const entity = Object.assign(Object.create(ProjTestEmployee.prototype), e) as ProjTestEmployee;
      await repo.save(entity);
    }
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await conn.close();
    await ds.close();
  });

  // ──────────────────────────────────────────────
  // findAll with projections
  // ──────────────────────────────────────────────

  it("findAll(EmployeeSummary) returns all rows with only firstName+lastName", async () => {
    const results = await repo.findAll(EmployeeSummary as any);
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const r of results) {
      expect(r).toBeInstanceOf(EmployeeSummary);
      expect(r.firstName).toBeDefined();
      expect(r.lastName).toBeDefined();
    }
  });

  it("findAll(EmployeeContact) returns all rows with only firstName+email", async () => {
    const results = await repo.findAll(EmployeeContact as any);
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const r of results) {
      expect(r).toBeInstanceOf(EmployeeContact);
      expect(r.firstName).toBeDefined();
      expect(r.email).toBeDefined();
    }
  });

  it("projection results do NOT contain fields not in the projection", async () => {
    const results = await repo.findAll(EmployeeSummary as any);
    const first = results[0] as any;
    // EmployeeSummary only has firstName and lastName
    expect(first.email).toBeUndefined();
    expect(first.salary).toBeUndefined();
    expect(first.department).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // findById with projections
  // ──────────────────────────────────────────────

  it("findById with projection returns single projected row", async () => {
    const all = await repo.findAll();
    const firstId = all[0].id;

    const result = await (repo as any).findById(firstId, EmployeeSummary);
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(EmployeeSummary);
    expect(result.firstName).toBeDefined();
    expect(result.lastName).toBeDefined();
  });

  it("findById with projection returns null for non-existent", async () => {
    const result = await (repo as any).findById(999999, EmployeeSummary);
    expect(result).toBeNull();
  });

  // ──────────────────────────────────────────────
  // Derived query with projection
  // ──────────────────────────────────────────────

  it("derived query with projection: findByDepartment with EmployeeSummary", async () => {
    const results = await (repo as any).findByDepartment("Engineering", EmployeeSummary);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(EmployeeSummary);
      expect(r.firstName).toBeDefined();
      expect(r.lastName).toBeDefined();
      // Should NOT have fields outside projection
      expect((r as any).email).toBeUndefined();
      expect((r as any).salary).toBeUndefined();
    }
  });

  // ──────────────────────────────────────────────
  // Multiple projections on same entity
  // ──────────────────────────────────────────────

  it("multiple different projections on same entity work independently", async () => {
    const summaries = await repo.findAll(EmployeeSummary as any);
    const contacts = await repo.findAll(EmployeeContact as any);

    // Both should have the same number of rows
    expect(summaries.length).toBe(contacts.length);

    // But different shapes
    const summary = summaries[0] as any;
    const contact = contacts[0] as any;

    expect(summary.lastName).toBeDefined();
    expect(summary.email).toBeUndefined();

    expect(contact.email).toBeDefined();
    expect(contact.lastName).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────

  it("empty result returns empty array with projection", async () => {
    const results = await (repo as any).findByDepartment("zzz_nonexistent", EmployeeSummary);
    expect(results).toEqual([]);
  });

  it("findAll without projection returns full entities", async () => {
    const results = await repo.findAll();
    expect(results.length).toBeGreaterThanOrEqual(6);
    const first = results[0];
    // Full entity should have all fields
    expect(first.firstName).toBeDefined();
    expect(first.lastName).toBeDefined();
    expect(first.email).toBeDefined();
    expect(first.department).toBeDefined();
  });
});
