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
        `CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  user_name TEXT,\n  active BOOLEAN\n)`,
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
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS items");
    });

    it("infers TEXT type from string default", () => {
      @Table("t1")
      class T1 {
        @Id @Column() id: number = 0;
        @Column() label: string = "";
      }
      new T1();

      const sql = generator.generateCreateTable(T1);
      expect(sql).toContain("label TEXT");
    });

    it("infers INTEGER type from number default", () => {
      @Table("t2")
      class T2 {
        @Id @Column() id: number = 0;
        @Column() count: number = 0;
      }
      new T2();

      const sql = generator.generateCreateTable(T2);
      expect(sql).toContain("count INTEGER");
    });

    it("infers BOOLEAN type from boolean default", () => {
      @Table("t3")
      class T3 {
        @Id @Column() id: number = 0;
        @Column() enabled: boolean = true;
      }
      new T3();

      const sql = generator.generateCreateTable(T3);
      expect(sql).toContain("enabled BOOLEAN");
    });

    it("infers TIMESTAMPTZ type from Date default", () => {
      @Table("t4")
      class T4 {
        @Id @Column() id: number = 0;
        @CreatedDate @Column("created_at") createdAt: Date = new Date();
      }
      new T4();

      const sql = generator.generateCreateTable(T4);
      expect(sql).toContain("created_at TIMESTAMPTZ");
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
      expect(sql).toContain("id SERIAL PRIMARY KEY");
      expect(sql).toContain("price DECIMAL(10,2)");
      expect(sql).toContain("bio VARCHAR(500)");
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
      expect(pkLines[0]).toContain("id");
    });

    it("uses table name from @Table decorator", () => {
      @Table("custom_table_name")
      class CustomEntity {
        @Id @Column() id: number = 0;
      }
      new CustomEntity();

      const sql = generator.generateCreateTable(CustomEntity);
      expect(sql).toContain("custom_table_name");
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
      expect(sql).toContain("created_at TIMESTAMPTZ");
      expect(sql).toContain("updated_at TIMESTAMPTZ");
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
      const idIdx = sql.indexOf("id ");
      const alphaIdx = sql.indexOf("alpha ");
      const betaIdx = sql.indexOf("beta ");
      const gammaIdx = sql.indexOf("gamma ");
      expect(idIdx).toBeLessThan(alphaIdx);
      expect(alphaIdx).toBeLessThan(betaIdx);
      expect(betaIdx).toBeLessThan(gammaIdx);
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
      expect(sql).toBe("DROP TABLE drop_test");
    });

    it("generates DROP TABLE IF EXISTS", () => {
      @Table("drop_test2")
      class DropTest2 {
        @Id @Column() id: number = 0;
      }
      new DropTest2();

      const sql = generator.generateDropTable(DropTest2, { ifExists: true });
      expect(sql).toBe("DROP TABLE IF EXISTS drop_test2");
    });

    it("generates DROP TABLE CASCADE", () => {
      @Table("drop_test3")
      class DropTest3 {
        @Id @Column() id: number = 0;
      }
      new DropTest3();

      const sql = generator.generateDropTable(DropTest3, { cascade: true });
      expect(sql).toBe("DROP TABLE drop_test3 CASCADE");
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
      expect(sql).toBe("DROP TABLE IF EXISTS drop_test4 CASCADE");
    });
  });
});
