/**
 * Adversarial E2E tests for @Embeddable/@Embedded repository integration (Y3 Q1).
 * Tests save/load, null embedded, update embedded fields, dual embeds, large embeds,
 * and DDL verification against live Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  Embeddable,
  Embedded,
  DdlGenerator,
  createRepository,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();
const generator = new DdlGenerator();

// --- Embeddable Definitions ---

@Embeddable
class E2eAddress {
  @Column() street: string = "";
  @Column() city: string = "";
  @Column() zip: string = "";
}

@Embeddable
class E2eCoordinate {
  @Column({ type: "DOUBLE PRECISION" }) lat: number = 0;
  @Column({ type: "DOUBLE PRECISION" }) lng: number = 0;
}

// --- Entity Definitions ---

// Single @Embedded
@Table("e2e_emb_person")
class E2ePerson {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
  @Embedded({ target: () => E2eAddress, prefix: "home_" })
  homeAddress!: E2eAddress;
}

// Dual @Embedded same type, different prefix
@Table("e2e_emb_company")
class E2eCompany {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() companyName: string = "";
  @Embedded({ target: () => E2eAddress, prefix: "hq_" })
  hqAddress!: E2eAddress;
  @Embedded({ target: () => E2eAddress, prefix: "ship_" })
  shipAddress!: E2eAddress;
}

// Mixed @Embedded + @Embedded
@Table("e2e_emb_place")
class E2ePlace {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() label: string = "";
  @Embedded({ target: () => E2eAddress, prefix: "addr_" })
  address!: E2eAddress;
  @Embedded({ target: () => E2eCoordinate, prefix: "geo_" })
  location!: E2eCoordinate;
}

// Register metadata
new E2eAddress();
new E2eCoordinate();
new E2ePerson();
new E2eCompany();
new E2ePlace();

// Helper: create entity without id (id=undefined triggers INSERT path)
function newEntity<T>(cls: new (...args: any[]) => T, fields: Partial<T>): T {
  return Object.assign(Object.create(cls.prototype), fields) as T;
}

function newAddress(street: string, city: string, zip: string): E2eAddress {
  return Object.assign(Object.create(E2eAddress.prototype), { street, city, zip });
}

function newCoord(lat: number, lng: number): E2eCoordinate {
  return Object.assign(Object.create(E2eCoordinate.prototype), { lat, lng });
}

describe.skipIf(!canConnect)("@Embedded adversarial: repository E2E (Postgres)", () => {
  let ds: PgDataSource;
  let conn: Connection;

  const ALL_TABLES = [
    "e2e_emb_place",
    "e2e_emb_company",
    "e2e_emb_person",
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();

    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    await stmt.executeUpdate(generator.generateCreateTable(E2ePerson));
    await stmt.executeUpdate(generator.generateCreateTable(E2eCompany));
    await stmt.executeUpdate(generator.generateCreateTable(E2ePlace));
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      for (const table of ALL_TABLES) {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  async function clearAllData() {
    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DELETE FROM ${table}`);
    }
  }

  // ─── DDL Verification ───

  describe("DDL schema verification", () => {
    it("prefixed columns exist in the database table", async () => {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'e2e_emb_person'
        ORDER BY ordinal_position
      `);
      const columns: string[] = [];
      while (await rs.next()) {
        columns.push(rs.getString("column_name")!);
      }
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("home_street");
      expect(columns).toContain("home_city");
      expect(columns).toContain("home_zip");
    });

    it("dual @Embedded generates distinct prefixed columns in same table", async () => {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'e2e_emb_company'
        ORDER BY ordinal_position
      `);
      const columns: string[] = [];
      while (await rs.next()) {
        columns.push(rs.getString("column_name")!);
      }
      expect(columns).toContain("hq_street");
      expect(columns).toContain("hq_city");
      expect(columns).toContain("hq_zip");
      expect(columns).toContain("ship_street");
      expect(columns).toContain("ship_city");
      expect(columns).toContain("ship_zip");
    });

    it("mixed @Embedded types generate correct column types", async () => {
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'e2e_emb_place'
        ORDER BY ordinal_position
      `);
      const cols: Record<string, string> = {};
      while (await rs.next()) {
        cols[rs.getString("column_name")!] = rs.getString("data_type")!;
      }
      expect(cols["addr_street"]).toBe("text");
      expect(cols["addr_city"]).toBe("text");
      expect(cols["geo_lat"]).toBe("double precision");
      expect(cols["geo_lng"]).toBe("double precision");
    });
  });

  // ─── Save and Load ───

  describe("save and load", () => {
    it("save entity with embedded then load — embedded reconstructed", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const person = newEntity(E2ePerson, {
        name: "Alice",
        homeAddress: newAddress("123 Main St", "Springfield", "62701"),
      });

      const saved = await repo.save(person);
      expect(saved.id).toBeGreaterThan(0);

      // Load with fresh repo to avoid cache
      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe("Alice");
      expect(loaded!.homeAddress).toBeDefined();
      expect(loaded!.homeAddress.street).toBe("123 Main St");
      expect(loaded!.homeAddress.city).toBe("Springfield");
      expect(loaded!.homeAddress.zip).toBe("62701");
    });

    it("embedded object has correct prototype after load", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const person = newEntity(E2ePerson, {
        name: "Proto",
        homeAddress: newAddress("1 Proto St", "ProtoCity", "00001"),
      });
      const saved = await repo.save(person);

      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded).not.toBeNull();
      // The row mapper should reconstruct with E2eAddress prototype
      expect(loaded!.homeAddress).toBeInstanceOf(E2eAddress);
    });

    it("save entity without setting embedded — columns are null in DB", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      // Don't set homeAddress
      const person = newEntity(E2ePerson, { name: "NoAddress" });
      const saved = await repo.save(person);

      // Verify columns are NULL in database
      const stmt = conn.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT home_street, home_city, home_zip FROM e2e_emb_person WHERE id = ${saved.id}`,
      );
      await rs.next();
      const row = rs.getRow();
      expect(row.home_street).toBeNull();
      expect(row.home_city).toBeNull();
      expect(row.home_zip).toBeNull();
    });

    it("dual @Embedded — both embedded objects loaded correctly", async () => {
      await clearAllData();

      const repo = createRepository<E2eCompany, number>(E2eCompany, ds);
      const company = newEntity(E2eCompany, {
        companyName: "Acme Corp",
        hqAddress: newAddress("100 HQ Blvd", "HQ City", "10001"),
        shipAddress: newAddress("200 Ship Lane", "Ship Town", "20002"),
      });

      const saved = await repo.save(company);
      const freshRepo = createRepository<E2eCompany, number>(E2eCompany, ds);
      const loaded = await freshRepo.findById(saved.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.companyName).toBe("Acme Corp");
      expect(loaded!.hqAddress.street).toBe("100 HQ Blvd");
      expect(loaded!.hqAddress.city).toBe("HQ City");
      expect(loaded!.hqAddress.zip).toBe("10001");
      expect(loaded!.shipAddress.street).toBe("200 Ship Lane");
      expect(loaded!.shipAddress.city).toBe("Ship Town");
      expect(loaded!.shipAddress.zip).toBe("20002");
    });

    it("mixed embeddable types — both loaded with correct data", async () => {
      await clearAllData();

      const repo = createRepository<E2ePlace, number>(E2ePlace, ds);
      const place = newEntity(E2ePlace, {
        label: "Central Park",
        address: newAddress("1 Park Ave", "New York", "10021"),
        location: newCoord(40.7829, -73.9654),
      });

      const saved = await repo.save(place);
      const freshRepo = createRepository<E2ePlace, number>(E2ePlace, ds);
      const loaded = await freshRepo.findById(saved.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.label).toBe("Central Park");
      expect(loaded!.address.street).toBe("1 Park Ave");
      expect(loaded!.address.city).toBe("New York");
      expect(loaded!.location.lat).toBeCloseTo(40.7829, 4);
      expect(loaded!.location.lng).toBeCloseTo(-73.9654, 4);
    });
  });

  // ─── Update Embedded Fields ───

  describe("update embedded fields", () => {
    it("update one field in embedded — change persisted", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const person = newEntity(E2ePerson, {
        name: "Bob",
        homeAddress: newAddress("1 Old St", "Old City", "11111"),
      });
      const saved = await repo.save(person);

      // Load, modify, save
      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded = await freshRepo.findById(saved.id);
      loaded!.homeAddress.city = "New City";
      await freshRepo.save(loaded!);

      // Verify
      const freshRepo2 = createRepository<E2ePerson, number>(E2ePerson, ds);
      const reloaded = await freshRepo2.findById(saved.id);
      expect(reloaded!.homeAddress.city).toBe("New City");
      expect(reloaded!.homeAddress.street).toBe("1 Old St"); // unchanged
    });

    it("replace entire embedded object — all fields updated", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const person = newEntity(E2ePerson, {
        name: "Carol",
        homeAddress: newAddress("1 Alpha", "AlphaCity", "11111"),
      });
      const saved = await repo.save(person);

      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded = await freshRepo.findById(saved.id);
      loaded!.homeAddress = newAddress("2 Beta", "BetaCity", "22222");
      await freshRepo.save(loaded!);

      const freshRepo2 = createRepository<E2ePerson, number>(E2ePerson, ds);
      const reloaded = await freshRepo2.findById(saved.id);
      expect(reloaded!.homeAddress.street).toBe("2 Beta");
      expect(reloaded!.homeAddress.city).toBe("BetaCity");
      expect(reloaded!.homeAddress.zip).toBe("22222");
    });
  });

  // ─── findAll with Embedded ───

  describe("findAll with embedded", () => {
    it("findAll loads embedded objects for all results", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      await repo.save(newEntity(E2ePerson, {
        name: "User1",
        homeAddress: newAddress("1 A", "CityA", "11111"),
      }));
      await repo.save(newEntity(E2ePerson, {
        name: "User2",
        homeAddress: newAddress("2 B", "CityB", "22222"),
      }));

      // Use fresh repo to avoid cache
      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const all = await freshRepo.findAll();
      expect(all).toHaveLength(2);

      const cities = all.map(p => p.homeAddress.city).sort();
      expect(cities).toEqual(["CityA", "CityB"]);
    });
  });

  // ─── Edge Cases ───

  describe("edge cases", () => {
    it("same embedded data in two entities — they are independent", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const addr = newAddress("1 Shared", "SharedCity", "33333");

      const p1 = newEntity(E2ePerson, { name: "P1", homeAddress: addr });
      const p2 = newEntity(E2ePerson, { name: "P2", homeAddress: addr });

      const saved1 = await repo.save(p1);
      const saved2 = await repo.save(p2);

      // Update p1's address — p2 should be unaffected
      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded1 = await freshRepo.findById(saved1.id);
      loaded1!.homeAddress.city = "Changed";
      await freshRepo.save(loaded1!);

      const freshRepo2 = createRepository<E2ePerson, number>(E2ePerson, ds);
      const reloaded2 = await freshRepo2.findById(saved2.id);
      expect(reloaded2!.homeAddress.city).toBe("SharedCity"); // unchanged
    });

    it("empty string values in embedded fields — stored and loaded correctly", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const person = newEntity(E2ePerson, {
        name: "EmptyFields",
        homeAddress: newAddress("", "", ""),
      });
      const saved = await repo.save(person);

      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded!.homeAddress.street).toBe("");
      expect(loaded!.homeAddress.city).toBe("");
      expect(loaded!.homeAddress.zip).toBe("");
    });

    it("special characters in embedded field values", async () => {
      await clearAllData();

      const repo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const person = newEntity(E2ePerson, {
        name: "Special",
        homeAddress: newAddress("O'Malley's \"Road\" #42", "St. Mary's; DROP TABLE--", "12345"),
      });
      const saved = await repo.save(person);

      const freshRepo = createRepository<E2ePerson, number>(E2ePerson, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded!.homeAddress.street).toBe("O'Malley's \"Road\" #42");
      expect(loaded!.homeAddress.city).toBe("St. Mary's; DROP TABLE--");
    });

    it("numeric precision preserved in embedded DOUBLE PRECISION fields", async () => {
      await clearAllData();

      const repo = createRepository<E2ePlace, number>(E2ePlace, ds);
      const place = newEntity(E2ePlace, {
        label: "Precise",
        address: newAddress("1 Precise", "PrecCity", "44444"),
        location: newCoord(51.50735, -0.127758),
      });
      const saved = await repo.save(place);

      const freshRepo = createRepository<E2ePlace, number>(E2ePlace, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded!.location.lat).toBeCloseTo(51.50735, 5);
      expect(loaded!.location.lng).toBeCloseTo(-0.127758, 5);
    });
  });
});
