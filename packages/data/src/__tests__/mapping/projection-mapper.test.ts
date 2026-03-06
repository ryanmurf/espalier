import { describe, expect, it } from "vitest";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { Projection } from "../../decorators/projection.js";
import { Table } from "../../decorators/table.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import { createProjectionMapper } from "../../mapping/projection-mapper.js";

@Table("users")
class User {
  @Id @Column() id: number = 0;
  @Column("user_name") name: string = "";
  @Column() email: string = "";
  @Column() age: number = 0;
  @Column({ type: "BOOLEAN" }) active: boolean = true;
}
new User();

const userMetadata = getEntityMetadata(User);

@Projection({ entity: User })
class UserSummary {
  @Column("user_name") name: string = "";
  @Column() email: string = "";
}
new UserSummary();

@Projection({ entity: User })
class UserMinimal {
  @Column("user_name") name: string = "";
}
new UserMinimal();

describe("ProjectionMapper", () => {
  it("createProjectionMapper returns correct column list", () => {
    const mapper = createProjectionMapper(UserSummary, userMetadata);
    expect(mapper.columns).toEqual(["user_name", "email"]);
  });

  it("mapRow creates an instance of the projection class", () => {
    const mapper = createProjectionMapper(UserSummary, userMetadata);
    const row = { user_name: "Alice", email: "alice@example.com" };
    const result = mapper.mapRow(row);
    expect(result).toBeInstanceOf(UserSummary);
    expect(result.name).toBe("Alice");
    expect(result.email).toBe("alice@example.com");
  });

  it("projection with subset of entity columns lists only those columns", () => {
    const mapper = createProjectionMapper(UserMinimal, userMetadata);
    expect(mapper.columns).toEqual(["user_name"]);
    expect(mapper.columns).not.toContain("email");
    expect(mapper.columns).not.toContain("age");
  });

  it("handles null values in projected columns", () => {
    const mapper = createProjectionMapper(UserSummary, userMetadata);
    const row = { user_name: "Alice", email: null };
    const result = mapper.mapRow(row);
    expect(result.name).toBe("Alice");
    expect(result.email).toBeNull();
  });

  it("handles various column types (string, number, boolean)", () => {
    @Projection({ entity: User })
    class UserTyped {
      @Column("user_name") name: string = "";
      @Column() age: number = 0;
      @Column() active: boolean = false;
    }
    new UserTyped();

    const mapper = createProjectionMapper(UserTyped, userMetadata);
    const row = { user_name: "Alice", age: 30, active: true };
    const result = mapper.mapRow(row);
    expect(result.name).toBe("Alice");
    expect(result.age).toBe(30);
    expect(result.active).toBe(true);
  });

  it("throws when projection class has no @Column fields", () => {
    class EmptyProjection {}

    expect(() => createProjectionMapper(EmptyProjection as any, userMetadata)).toThrow(/no @Column decorated fields/);
  });
});
