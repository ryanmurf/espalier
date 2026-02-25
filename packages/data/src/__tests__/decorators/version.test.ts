import { describe, it, expect } from "vitest";
import { Version, getVersionField } from "../../decorators/version.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import { OptimisticLockException } from "../../repository/optimistic-lock.js";

@Table("docs")
class VersionedEntity {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Version @Column() version: number = 0;
}
new VersionedEntity();

@Table("notes")
class UnversionedEntity {
  @Id @Column() id: number = 0;
  @Column() text: string = "";
}
new UnversionedEntity();

describe("@Version decorator", () => {
  it("getVersionField returns field name when @Version is present", () => {
    const field = getVersionField(VersionedEntity);
    expect(field).toBe("version");
  });

  it("getVersionField returns undefined when @Version is absent", () => {
    const field = getVersionField(UnversionedEntity);
    expect(field).toBeUndefined();
  });

  it("multiple @Version fields throws error at initialization", () => {
    expect(() => {
      @Table("multi_ver")
      class MultiVersionEntity {
        @Id @Column() id: number = 0;
        @Version @Column() version1: number = 0;
        @Version @Column() version2: number = 0;
      }
      new MultiVersionEntity();
    }).toThrow(/Multiple @Version fields/);
  });

  it("EntityMetadata.versionField is populated when @Version is present", () => {
    const metadata = getEntityMetadata(VersionedEntity);
    expect(metadata.versionField).toBe("version");
  });

  it("EntityMetadata.versionField is undefined when @Version is absent", () => {
    const metadata = getEntityMetadata(UnversionedEntity);
    expect(metadata.versionField).toBeUndefined();
  });
});

describe("OptimisticLockException", () => {
  it("has correct message format with version mismatch", () => {
    const ex = new OptimisticLockException("Document", 42, 3, 5);
    expect(ex.message).toContain("Document");
    expect(ex.message).toContain("42");
    expect(ex.message).toContain("expected version 3");
    expect(ex.message).toContain("found 5");
  });

  it("has correct message when entity was deleted", () => {
    const ex = new OptimisticLockException("Document", 42, 3, null);
    expect(ex.message).toContain("deleted by another transaction");
  });

  it("exposes entityName, id, expectedVersion, actualVersion", () => {
    const ex = new OptimisticLockException("Document", 42, 3, 5);
    expect(ex.entityName).toBe("Document");
    expect(ex.id).toBe(42);
    expect(ex.expectedVersion).toBe(3);
    expect(ex.actualVersion).toBe(5);
  });

  it("is an instance of Error", () => {
    const ex = new OptimisticLockException("Document", 1, 1, 2);
    expect(ex).toBeInstanceOf(Error);
    expect(ex.name).toBe("OptimisticLockException");
  });
});
