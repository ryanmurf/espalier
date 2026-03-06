import { describe, expect, it } from "vitest";
import { Column, getColumnMappings } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { getProjectionMetadata, Projection } from "../../decorators/projection.js";
import { Table } from "../../decorators/table.js";

@Table("users")
class User {
  @Id @Column() id: number = 0;
  @Column("user_name") name: string = "";
  @Column() email: string = "";
  @Column() age: number = 0;
}
new User();

@Projection({ entity: User })
class UserSummary {
  @Column("user_name") name: string = "";
  @Column() email: string = "";
}
new UserSummary();

class PlainClass {
  name: string = "";
}

describe("@Projection decorator", () => {
  it("stores metadata on the decorated class", () => {
    const meta = getProjectionMetadata(UserSummary);
    expect(meta).toBeDefined();
    expect(meta!.entity).toBe(User);
  });

  it("getProjectionMetadata retrieves the entity reference", () => {
    const meta = getProjectionMetadata(UserSummary);
    expect(meta).toBeDefined();
    expect(meta!.entity).toBe(User);
  });

  it("returns undefined for class without @Projection", () => {
    const meta = getProjectionMetadata(PlainClass);
    expect(meta).toBeUndefined();
  });

  it("projection class with @Column decorators lists correct columns", () => {
    const columns = getColumnMappings(UserSummary);
    expect(columns.size).toBe(2);
    expect(columns.get("name")).toBe("user_name");
    expect(columns.get("email")).toBe("email");
  });

  it("projection with custom column names resolves correctly", () => {
    const columns = getColumnMappings(UserSummary);
    // "name" field maps to "user_name" column
    expect(columns.get("name")).toBe("user_name");
  });
});
