import { describe, it, expect } from "vitest";
import { DdlGenerator } from "../../schema/ddl-generator.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { CreatedDate, LastModifiedDate } from "../../decorators/auditing.js";

const generator = new DdlGenerator();

describe("DdlGenerator", () => {
  describe("generateCreateTable()", () => {
    it("generates CREATE TABLE for a basic entity", () => {
      @Table("users")
      class User {
        @Id @Column() id: number = 0;
        @Column("user_name") name: string = "";
        @Column() active: boolean = false;
      }
      new User();

      const sql = generator.generateCreateTable(User);
      expect(sql).toBe(
        `CREATE TABLE "users" (\n  "id" INTEGER PRIMARY KEY,\n  "user_name" TEXT,\n  "active" BOOLEAN\n)`,
      );
    });

    it("generates CREATE TABLE IF NOT EXISTS", () => {
      @Table("items")
      class Item {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new Item();

      const sql = generator.generateCreateTable(Item, { ifNotExists: true });
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "items"');
    });

    it("infers TEXT type from string default", () => {
      @Table("t1")
      class T1 {
        @Id @Column() id: number = 0;
        @Column() label: string = "";
      }
      new T1();

      const sql = generator.generateCreateTable(T1);
      expect(sql).toContain('"label" TEXT');
    });

    it("infers INTEGER type from number default", () => {
      @Table("t2")
      class T2 {
        @Id @Column() id: number = 0;
        @Column() count: number = 0;
      }
      new T2();

      const sql = generator.generateCreateTable(T2);
      expect(sql).toContain('"count" INTEGER');
    });

    it("infers BOOLEAN type from boolean default", () => {
      @Table("t3")
      class T3 {
        @Id @Column() id: number = 0;
        @Column() enabled: boolean = true;
      }
      new T3();

      const sql = generator.generateCreateTable(T3);
      expect(sql).toContain('"enabled" BOOLEAN');
    });

    it("infers TIMESTAMPTZ type from Date default", () => {
      @Table("t4")
      class T4 {
        @Id @Column() id: number = 0;
        @CreatedDate @Column("created_at") createdAt: Date = new Date();
      }
      new T4();

      const sql = generator.generateCreateTable(T4);
      expect(sql).toContain('"created_at" TIMESTAMPTZ');
    });

    it("uses explicit type from @Column({ type })", () => {
      @Table("t5")
      class T5 {
        @Id @Column({ type: "SERIAL" }) id: number = 0;
        @Column({ name: "price", type: "DECIMAL(10,2)" }) price: number = 0;
        @Column({ name: "bio", type: "VARCHAR(500)" }) bio: string = "";
      }
      new T5();

      const sql = generator.generateCreateTable(T5);
      expect(sql).toContain('"id" SERIAL PRIMARY KEY');
      expect(sql).toContain('"price" DECIMAL(10,2)');
      expect(sql).toContain('"bio" VARCHAR(500)');
    });

    it("marks only the @Id field as PRIMARY KEY", () => {
      @Table("t6")
      class T6 {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
        @Column() age: number = 0;
      }
      new T6();

      const sql = generator.generateCreateTable(T6);
      const lines = sql.split("\n");
      const pkLines = lines.filter((l) => l.includes("PRIMARY KEY"));
      expect(pkLines).toHaveLength(1);
      expect(pkLines[0]).toContain('"id"');
    });

    it("uses table name from @Table decorator", () => {
      @Table("custom_table_name")
      class CustomEntity {
        @Id @Column() id: number = 0;
      }
      new CustomEntity();

      const sql = generator.generateCreateTable(CustomEntity);
      expect(sql).toContain('"custom_table_name"');
    });

    it("handles entity with auditing columns", () => {
      @Table("audited")
      class Audited {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
        @CreatedDate @Column("created_at") createdAt: Date = new Date();
        @LastModifiedDate @Column("updated_at") updatedAt: Date = new Date();
      }
      new Audited();

      const sql = generator.generateCreateTable(Audited);
      expect(sql).toContain('"created_at" TIMESTAMPTZ');
      expect(sql).toContain('"updated_at" TIMESTAMPTZ');
    });

    it("generates columns in field order", () => {
      @Table("ordered")
      class Ordered {
        @Id @Column() id: number = 0;
        @Column() alpha: string = "";
        @Column() beta: number = 0;
        @Column() gamma: boolean = false;
      }
      new Ordered();

      const sql = generator.generateCreateTable(Ordered);
      const idIdx = sql.indexOf('"id" ');
      const alphaIdx = sql.indexOf('"alpha" ');
      const betaIdx = sql.indexOf('"beta" ');
      const gammaIdx = sql.indexOf('"gamma" ');
      expect(idIdx).toBeLessThan(alphaIdx);
      expect(alphaIdx).toBeLessThan(betaIdx);
      expect(betaIdx).toBeLessThan(gammaIdx);
    });
  });

  describe("constraint support", () => {
    it("generates NOT NULL for nullable: false", () => {
      @Table("c1")
      class C1 {
        @Id @Column() id: number = 0;
        @Column({ nullable: false }) name: string = "";
      }
      new C1();

      const sql = generator.generateCreateTable(C1);
      expect(sql).toContain('"name" TEXT NOT NULL');
    });

    it("does not add NOT NULL when nullable is unset", () => {
      @Table("c2")
      class C2 {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new C2();

      const sql = generator.generateCreateTable(C2);
      expect(sql).toContain('"name" TEXT');
      expect(sql).not.toContain('"name" TEXT NOT NULL');
    });

    it("generates UNIQUE constraint", () => {
      @Table("c3")
      class C3 {
        @Id @Column() id: number = 0;
        @Column({ unique: true }) email: string = "";
      }
      new C3();

      const sql = generator.generateCreateTable(C3);
      expect(sql).toContain('"email" TEXT UNIQUE');
    });

    it("generates DEFAULT clause with raw SQL expression", () => {
      @Table("c4")
      class C4 {
        @Id @Column() id: number = 0;
        @Column({ defaultValue: "'active'" }) status: string = "";
      }
      new C4();

      const sql = generator.generateCreateTable(C4);
      expect(sql).toContain(`"status" TEXT DEFAULT 'active'`);
    });

    it("generates DEFAULT NOW() for numeric default", () => {
      @Table("c5")
      class C5 {
        @Id @Column() id: number = 0;
        @Column({ defaultValue: "0" }) count: number = 0;
      }
      new C5();

      const sql = generator.generateCreateTable(C5);
      expect(sql).toContain('"count" INTEGER DEFAULT 0');
    });

    it("generates VARCHAR(n) when length is specified", () => {
      @Table("c6")
      class C6 {
        @Id @Column() id: number = 0;
        @Column({ length: 255 }) name: string = "";
      }
      new C6();

      const sql = generator.generateCreateTable(C6);
      expect(sql).toContain('"name" VARCHAR(255)');
    });

    it("explicit type takes precedence over length", () => {
      @Table("c7")
      class C7 {
        @Id @Column() id: number = 0;
        @Column({ type: "CHAR(10)", length: 255 }) code: string = "";
      }
      new C7();

      const sql = generator.generateCreateTable(C7);
      expect(sql).toContain('"code" CHAR(10)');
      expect(sql).not.toContain("VARCHAR(255)");
    });

    it("combines NOT NULL and UNIQUE constraints", () => {
      @Table("c8")
      class C8 {
        @Id @Column() id: number = 0;
        @Column({ nullable: false, unique: true }) email: string = "";
      }
      new C8();

      const sql = generator.generateCreateTable(C8);
      expect(sql).toContain('"email" TEXT NOT NULL UNIQUE');
    });

    it("combines NOT NULL, UNIQUE, and DEFAULT", () => {
      @Table("c9")
      class C9 {
        @Id @Column() id: number = 0;
        @Column({ nullable: false, unique: true, defaultValue: "'pending'" }) status: string = "";
      }
      new C9();

      const sql = generator.generateCreateTable(C9);
      expect(sql).toContain(`"status" TEXT NOT NULL UNIQUE DEFAULT 'pending'`);
    });

    it("combines length with NOT NULL", () => {
      @Table("c10")
      class C10 {
        @Id @Column() id: number = 0;
        @Column({ length: 100, nullable: false }) name: string = "";
      }
      new C10();

      const sql = generator.generateCreateTable(C10);
      expect(sql).toContain('"name" VARCHAR(100) NOT NULL');
    });

    it("@Id fields do not duplicate NOT NULL (PRIMARY KEY implies it)", () => {
      @Table("c11")
      class C11 {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new C11();

      const sql = generator.generateCreateTable(C11);
      expect(sql).toContain('"id" INTEGER PRIMARY KEY');
      expect(sql).not.toContain("PRIMARY KEY NOT NULL");
    });

    it("@CreatedDate gets DEFAULT NOW() automatically", () => {
      @Table("c12")
      class C12 {
        @Id @Column() id: number = 0;
        @CreatedDate @Column("created_at") createdAt: Date = new Date();
      }
      new C12();

      const sql = generator.generateCreateTable(C12);
      expect(sql).toContain('"created_at" TIMESTAMPTZ DEFAULT NOW()');
    });

    it("explicit defaultValue on @CreatedDate overrides automatic DEFAULT NOW()", () => {
      @Table("c13")
      class C13 {
        @Id @Column() id: number = 0;
        @CreatedDate @Column({ name: "created_at", defaultValue: "CURRENT_TIMESTAMP" }) createdAt: Date = new Date();
      }
      new C13();

      const sql = generator.generateCreateTable(C13);
      expect(sql).toContain('"created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP');
      expect(sql).not.toContain("DEFAULT NOW()");
    });

    it("@LastModifiedDate does not get automatic DEFAULT", () => {
      @Table("c14")
      class C14 {
        @Id @Column() id: number = 0;
        @LastModifiedDate @Column("updated_at") updatedAt: Date = new Date();
      }
      new C14();

      const sql = generator.generateCreateTable(C14);
      expect(sql).toContain('"updated_at" TIMESTAMPTZ');
      expect(sql).not.toContain('"updated_at" TIMESTAMPTZ DEFAULT');
    });

    it("generates full entity with mixed constraints", () => {
      @Table("products")
      class Product {
        @Id @Column({ type: "SERIAL" }) id: number = 0;
        @Column({ length: 200, nullable: false }) name: string = "";
        @Column({ nullable: false, unique: true, length: 50 }) sku: string = "";
        @Column({ type: "DECIMAL(10,2)", defaultValue: "0.00" }) price: number = 0;
        @Column({ defaultValue: "true" }) active: boolean = true;
        @CreatedDate @Column("created_at") createdAt: Date = new Date();
      }
      new Product();

      const sql = generator.generateCreateTable(Product);
      expect(sql).toContain('"id" SERIAL PRIMARY KEY');
      expect(sql).toContain('"name" VARCHAR(200) NOT NULL');
      expect(sql).toContain('"sku" VARCHAR(50) NOT NULL UNIQUE');
      expect(sql).toContain('"price" DECIMAL(10,2) DEFAULT 0.00');
      expect(sql).toContain('"active" BOOLEAN DEFAULT true');
      expect(sql).toContain('"created_at" TIMESTAMPTZ DEFAULT NOW()');
    });
  });

  describe("generateDropTable()", () => {
    it("generates basic DROP TABLE", () => {
      @Table("drop_test")
      class DropTest {
        @Id @Column() id: number = 0;
      }
      new DropTest();

      const sql = generator.generateDropTable(DropTest);
      expect(sql).toBe('DROP TABLE "drop_test"');
    });

    it("generates DROP TABLE IF EXISTS", () => {
      @Table("drop_test2")
      class DropTest2 {
        @Id @Column() id: number = 0;
      }
      new DropTest2();

      const sql = generator.generateDropTable(DropTest2, { ifExists: true });
      expect(sql).toBe('DROP TABLE IF EXISTS "drop_test2"');
    });

    it("generates DROP TABLE CASCADE", () => {
      @Table("drop_test3")
      class DropTest3 {
        @Id @Column() id: number = 0;
      }
      new DropTest3();

      const sql = generator.generateDropTable(DropTest3, { cascade: true });
      expect(sql).toBe('DROP TABLE "drop_test3" CASCADE');
    });

    it("generates DROP TABLE IF EXISTS CASCADE", () => {
      @Table("drop_test4")
      class DropTest4 {
        @Id @Column() id: number = 0;
      }
      new DropTest4();

      const sql = generator.generateDropTable(DropTest4, {
        ifExists: true,
        cascade: true,
      });
      expect(sql).toBe('DROP TABLE IF EXISTS "drop_test4" CASCADE');
    });
  });
});
