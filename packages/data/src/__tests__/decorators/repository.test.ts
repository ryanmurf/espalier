import { describe, expect, it } from "vitest";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { getRegisteredRepositories, getRepositoryMetadata, Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";

@Table("users")
class User {
  @Id
  @Column()
  id: number = 0;

  @Column()
  name: string = "";
}

@Table("orders")
class Order {
  @Id
  @Column()
  id: number = 0;

  @Column({ name: "total_amount" })
  totalAmount: number = 0;
}

describe("@Repository decorator", () => {
  it("registers metadata for a decorated class", () => {
    @Repository({ entity: User })
    class UserRepository {}

    const meta = getRepositoryMetadata(UserRepository);
    expect(meta).toBeDefined();
    expect(meta!.entity).toBe(User);
  });

  it("stores optional tableName", () => {
    @Repository({ entity: User, tableName: "custom_users" })
    class CustomUserRepository {}

    const meta = getRepositoryMetadata(CustomUserRepository);
    expect(meta).toBeDefined();
    expect(meta!.tableName).toBe("custom_users");
  });

  it("returns undefined for non-decorated class", () => {
    class PlainClass {}
    const meta = getRepositoryMetadata(PlainClass);
    expect(meta).toBeUndefined();
  });

  it("registers the entity class in the global registry", () => {
    @Repository({ entity: Order })
    class OrderRepository {}

    const registry = getRegisteredRepositories();
    expect(registry.has(Order)).toBe(true);
  });

  it("returns the class unchanged", () => {
    @Repository({ entity: User })
    class TestRepo {
      greet() {
        return "hello";
      }
    }

    const repo = new TestRepo();
    expect(repo.greet()).toBe("hello");
  });
});
