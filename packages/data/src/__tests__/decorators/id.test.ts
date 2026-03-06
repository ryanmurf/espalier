import { describe, expect, it } from "vitest";
import { getIdField, Id } from "../../decorators/id.js";

describe("@Id decorator", () => {
  it("stores the id field name", () => {
    class User {
      @Id id: number = 0;
    }
    new User();

    expect(getIdField(User)).toBe("id");
  });

  it("returns undefined for a class without @Id", () => {
    class Plain {}

    expect(getIdField(Plain)).toBeUndefined();
  });

  it("isolates metadata between classes", () => {
    class A {
      @Id pk: number = 0;
    }
    class B {
      @Id uuid: string = "";
    }
    new A();
    new B();

    expect(getIdField(A)).toBe("pk");
    expect(getIdField(B)).toBe("uuid");
  });
});
