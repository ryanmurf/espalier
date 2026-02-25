import { describe, it, expect } from "vitest";
import {
  CreatedDate,
  LastModifiedDate,
  getCreatedDateField,
  getLastModifiedDateField,
} from "../../decorators/auditing.js";

describe("@CreatedDate decorator", () => {
  it("stores the createdDate field name", () => {
    class Entity {
      @CreatedDate createdAt: Date = new Date();
    }
    new Entity();

    expect(getCreatedDateField(Entity)).toBe("createdAt");
  });

  it("returns undefined for a class without @CreatedDate", () => {
    class Plain {}

    expect(getCreatedDateField(Plain)).toBeUndefined();
  });
});

describe("@LastModifiedDate decorator", () => {
  it("stores the lastModifiedDate field name", () => {
    class Entity {
      @LastModifiedDate updatedAt: Date = new Date();
    }
    new Entity();

    expect(getLastModifiedDateField(Entity)).toBe("updatedAt");
  });

  it("returns undefined for a class without @LastModifiedDate", () => {
    class Plain {}

    expect(getLastModifiedDateField(Plain)).toBeUndefined();
  });
});

describe("both auditing decorators together", () => {
  it("stores both fields independently", () => {
    class Entity {
      @CreatedDate createdAt: Date = new Date();
      @LastModifiedDate updatedAt: Date = new Date();
    }
    new Entity();

    expect(getCreatedDateField(Entity)).toBe("createdAt");
    expect(getLastModifiedDateField(Entity)).toBe("updatedAt");
  });
});
