import type { Connection, DataSource, PreparedStatement } from "espalier-jdbc";
import { describe, expect, it, vi } from "vitest";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import {
  createAutoRepository,
  getDeclaredDerivedMethods,
  validateDerivedMethods,
} from "../../repository/auto-repository.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

// --- Test Entities ---

@Table("users")
class User {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() email: string = "";
  @Column() age: number = 0;
}

@Table("products")
class Product {
  @Id @Column() id: number = 0;
  @Column() title: string = "";
  @Column() price: number = 0;
}

function createMockPreparedStatement(rs: TestResultSet): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 1),
    close: vi.fn(async () => {}),
  };
}

function createMockConnection(stmt: PreparedStatement): Connection {
  return {
    createStatement: vi.fn() as any,
    prepareStatement: vi.fn(() => stmt),
    beginTransaction: vi.fn() as any,
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  };
}

function createMockDataSource(conn: Connection): DataSource {
  return {
    getConnection: vi.fn(async () => conn),
    close: vi.fn(async () => {}),
  };
}

function makeDs(): DataSource {
  const rs = new TestResultSet([]);
  const stmt = createMockPreparedStatement(rs);
  const conn = createMockConnection(stmt);
  return createMockDataSource(conn);
}

// --- Tests ---

describe("getDeclaredDerivedMethods", () => {
  it("returns empty array for class with no derived methods", () => {
    @Repository({ entity: User })
    class EmptyRepo {}

    expect(getDeclaredDerivedMethods(EmptyRepo)).toEqual([]);
  });

  it("extracts findBy methods from prototype", () => {
    @Repository({ entity: User })
    class UserRepo {
      findByName(_name: string): any {}
      findByEmail(_email: string): any {}
    }

    const methods = getDeclaredDerivedMethods(UserRepo);
    expect(methods).toContain("findByName");
    expect(methods).toContain("findByEmail");
    expect(methods).toHaveLength(2);
  });

  it("extracts countBy, deleteBy, existsBy methods", () => {
    @Repository({ entity: User })
    class UserRepo {
      countByName(_name: string): any {}
      deleteByEmail(_email: string): any {}
      existsByName(_name: string): any {}
    }

    const methods = getDeclaredDerivedMethods(UserRepo);
    expect(methods).toContain("countByName");
    expect(methods).toContain("deleteByEmail");
    expect(methods).toContain("existsByName");
    expect(methods).toHaveLength(3);
  });

  it("extracts findDistinctBy methods", () => {
    @Repository({ entity: User })
    class UserRepo {
      findDistinctByName(_name: string): any {}
    }

    const methods = getDeclaredDerivedMethods(UserRepo);
    expect(methods).toContain("findDistinctByName");
  });

  it("ignores CRUD methods like findById, save, count", () => {
    @Repository({ entity: User })
    class UserRepo {
      findById(_id: number): any {}
      save(_entity: any): any {}
      count(): any {}
      findByName(_name: string): any {}
    }

    const methods = getDeclaredDerivedMethods(UserRepo);
    expect(methods).toEqual(["findByName"]);
  });

  it("ignores non-derived methods", () => {
    @Repository({ entity: User })
    class UserRepo {
      findByName(_name: string): any {}
      customHelper(): any {}
      getStats(): any {}
    }

    const methods = getDeclaredDerivedMethods(UserRepo);
    expect(methods).toEqual(["findByName"]);
  });

  it("ignores constructor", () => {
    @Repository({ entity: User })
    class UserRepo {
      constructor() {}
      findByName(_name: string): any {}
    }

    const methods = getDeclaredDerivedMethods(UserRepo);
    expect(methods).toEqual(["findByName"]);
  });
});

describe("validateDerivedMethods", () => {
  it("validates valid single-property method", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByName"], meta);

    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].methodName).toBe("findByName");
    expect(valid[0].descriptor.action).toBe("find");
    expect(valid[0].descriptor.properties[0].property).toBe("name");
  });

  it("validates multi-property And method", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByNameAndEmail"], meta);

    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].descriptor.properties).toHaveLength(2);
    expect(valid[0].descriptor.properties[0].property).toBe("name");
    expect(valid[0].descriptor.properties[1].property).toBe("email");
  });

  it("validates method with operator suffix", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByAgeGreaterThan"], meta);

    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].descriptor.properties[0].property).toBe("age");
    expect(valid[0].descriptor.properties[0].operator).toBe("GreaterThan");
  });

  it("validates countBy method", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["countByName"], meta);

    expect(errors).toHaveLength(0);
    expect(valid[0].descriptor.action).toBe("count");
  });

  it("validates deleteBy method", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["deleteByEmail"], meta);

    expect(errors).toHaveLength(0);
    expect(valid[0].descriptor.action).toBe("delete");
  });

  it("validates existsBy method", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["existsByName"], meta);

    expect(errors).toHaveLength(0);
    expect(valid[0].descriptor.action).toBe("exists");
  });

  it("returns error for unknown property", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByNonExistentField"], meta);

    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].methodName).toBe("findByNonExistentField");
    expect(errors[0].error).toContain("Unknown property");
  });

  it("returns error for unparseable method name", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findBy"], meta);

    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].methodName).toBe("findBy");
  });

  it("validates mix of valid and invalid methods", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByName", "findByFakeField", "countByEmail"], meta);

    expect(valid).toHaveLength(2);
    expect(valid.map((v) => v.methodName)).toEqual(["findByName", "countByEmail"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].methodName).toBe("findByFakeField");
  });

  it("validates Between operator (2 params)", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByAgeBetween"], meta);

    expect(errors).toHaveLength(0);
    expect(valid[0].descriptor.properties[0].operator).toBe("Between");
    expect(valid[0].descriptor.properties[0].paramCount).toBe(2);
  });

  it("validates IsNull operator (0 params)", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods(["findByEmailIsNull"], meta);

    expect(errors).toHaveLength(0);
    expect(valid[0].descriptor.properties[0].operator).toBe("IsNull");
    expect(valid[0].descriptor.properties[0].paramCount).toBe(0);
  });

  it("returns empty results for empty input", () => {
    const meta = getEntityMetadata(User);
    const { valid, errors } = validateDerivedMethods([], meta);

    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe("createAutoRepository with method validation", () => {
  it("passes with valid derived methods on prototype", () => {
    @Repository({ entity: User })
    class ValidUserRepo {
      findByName(_name: string): any {}
      findByEmail(_email: string): any {}
      countByAge(): any {}
    }

    const ds = makeDs();
    expect(() => createAutoRepository<User, number>(ValidUserRepo, ds)).not.toThrow();
  });

  it("throws when prototype has invalid derived method", () => {
    @Repository({ entity: User })
    class BadUserRepo {
      findByNonExistent(_val: string): any {}
    }

    const ds = makeDs();
    expect(() => createAutoRepository<User, number>(BadUserRepo, ds)).toThrow(/Invalid derived query methods/);
  });

  it("error message lists all invalid methods", () => {
    @Repository({ entity: User })
    class BadUserRepo {
      findByFoo(_val: string): any {}
      findByBar(_val: string): any {}
    }

    const ds = makeDs();
    expect(() => createAutoRepository<User, number>(BadUserRepo, ds)).toThrow(/findByFoo/);
    expect(() => createAutoRepository<User, number>(BadUserRepo, ds)).toThrow(/findByBar/);
  });

  it("skips validation when validateMethods is false", () => {
    @Repository({ entity: User })
    class BadUserRepo {
      findByNonExistent(_val: string): any {}
    }

    const ds = makeDs();
    expect(() =>
      createAutoRepository<User, number>(BadUserRepo, ds, {
        validateMethods: false,
      }),
    ).not.toThrow();
  });

  it("allows mix of CRUD overrides and derived methods", () => {
    @Repository({ entity: User })
    class MixedRepo {
      findByName(_name: string): any {}
    }

    const ds = makeDs();
    const repo = createAutoRepository<User, number>(MixedRepo, ds);
    expect(repo).toBeDefined();
    expect(typeof repo.findById).toBe("function");
  });

  it("succeeds when repository class has no prototype methods", () => {
    @Repository({ entity: User })
    class EmptyRepo {}

    const ds = makeDs();
    expect(() => createAutoRepository<User, number>(EmptyRepo, ds)).not.toThrow();
  });

  it("validates methods with complex operators", () => {
    @Repository({ entity: User })
    class ComplexRepo {
      findByNameLike(_pattern: string): any {}
      findByAgeBetween(_min: number, _max: number): any {}
      findByEmailIsNotNull(): any {}
      findByNameAndAgeGreaterThan(_name: string, _age: number): any {}
    }

    const ds = makeDs();
    expect(() => createAutoRepository<User, number>(ComplexRepo, ds)).not.toThrow();
  });

  it("derived methods still work via proxy after validation", async () => {
    @Repository({ entity: User })
    class UserRepo {
      findByName(_name: string): any {}
    }

    const rs = new TestResultSet([{ id: 1, name: "Alice", email: "a@test.com", age: 30 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepo, ds);
    const results = await (repo as any).findByName("Alice");

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice");
  });
});
