import { describe, expect, it } from "vitest";
import { CreatedDate, LastModifiedDate } from "../../decorators/auditing.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { Table } from "../../decorators/table.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";

describe("getEntityMetadata", () => {
  it("returns complete metadata for a fully-decorated class", () => {
    @Table("users")
    class User {
      @Id @Column() id: number = 0;
      @Column("user_name") name: string = "";
      @Column({ name: "email_address" }) email: string = "";
      @CreatedDate @Column("created_at") createdAt: Date = new Date();
      @LastModifiedDate
      @Column("updated_at")
      updatedAt: Date = new Date();
    }
    new User();

    const meta = getEntityMetadata(User);
    expect(meta.tableName).toBe("users");
    expect(meta.idField).toBe("id");
    expect(meta.createdDateField).toBe("createdAt");
    expect(meta.lastModifiedDateField).toBe("updatedAt");
    expect(meta.fields.length).toBe(5);

    const fieldMap = new Map(meta.fields.map((f) => [f.fieldName, f.columnName]));
    expect(fieldMap.get("id")).toBe("id");
    expect(fieldMap.get("name")).toBe("user_name");
    expect(fieldMap.get("email")).toBe("email_address");
    expect(fieldMap.get("createdAt")).toBe("created_at");
    expect(fieldMap.get("updatedAt")).toBe("updated_at");
  });

  it("throws when @Table is missing", () => {
    class NoTable {
      @Id @Column() id: number = 0;
    }
    new NoTable();

    expect(() => getEntityMetadata(NoTable)).toThrow(/No @Table decorator found/);
  });

  it("throws when @Id is missing", () => {
    @Table("things")
    class NoId {
      @Column() name: string = "";
    }
    new NoId();

    expect(() => getEntityMetadata(NoId)).toThrow(/No @Id decorator found/);
  });

  it("omits auditing fields when not decorated", () => {
    @Table("items")
    class Item {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }
    new Item();

    const meta = getEntityMetadata(Item);
    expect(meta.createdDateField).toBeUndefined();
    expect(meta.lastModifiedDateField).toBeUndefined();
  });
});
