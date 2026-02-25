import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../../query/query-builder.js";
import { col } from "../../query/column-ref.js";
import { and, or, not } from "../../query/criteria.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";

@Table("users")
class User {
  @Id @Column() id: number = 0;
  @Column("user_name") name: string = "";
  @Column("email_address") email: string = "";
  @Column() age: number = 0;
}
// Instantiate to trigger decorator initializers
new User();

describe("QueryBuilder.select", () => {
  it("builds a simple SELECT * from table string", () => {
    const q = QueryBuilder.select("users").build();
    expect(q.sql).toBe("SELECT * FROM users");
    expect(q.params).toEqual([]);
  });

  it("builds SELECT with entity class resolving columns", () => {
    const q = QueryBuilder.select(User).build();
    expect(q.sql).toBe(
      "SELECT id, user_name, email_address, age FROM users",
    );
    expect(q.params).toEqual([]);
  });

  it("builds SELECT with custom columns", () => {
    const q = QueryBuilder.select("users").columns("id", "name").build();
    expect(q.sql).toBe("SELECT id, name FROM users");
  });

  it("builds SELECT with WHERE clause", () => {
    const q = QueryBuilder.select("users")
      .where(col("age").gt(18))
      .build();
    expect(q.sql).toBe("SELECT * FROM users WHERE age > $1");
    expect(q.params).toEqual([18]);
  });

  it("builds SELECT with WHERE and AND", () => {
    const q = QueryBuilder.select("users")
      .where(col("age").gt(18))
      .and(col("user_name").like("J%"))
      .build();
    expect(q.sql).toBe(
      "SELECT * FROM users WHERE (age > $1 AND user_name LIKE $2)",
    );
    expect(q.params).toEqual([18, "J%"]);
  });

  it("builds SELECT with WHERE and OR", () => {
    const q = QueryBuilder.select("users")
      .where(col("status").eq("active"))
      .or(col("status").eq("pending"))
      .build();
    expect(q.sql).toBe(
      "SELECT * FROM users WHERE (status = $1 OR status = $2)",
    );
    expect(q.params).toEqual(["active", "pending"]);
  });

  it("builds SELECT with ORDER BY", () => {
    const q = QueryBuilder.select("users")
      .orderBy("name", "ASC")
      .orderBy("age", "DESC")
      .build();
    expect(q.sql).toBe("SELECT * FROM users ORDER BY name ASC, age DESC");
    expect(q.params).toEqual([]);
  });

  it("builds SELECT with LIMIT and OFFSET", () => {
    const q = QueryBuilder.select("users").limit(10).offset(20).build();
    expect(q.sql).toBe("SELECT * FROM users LIMIT $1 OFFSET $2");
    expect(q.params).toEqual([10, 20]);
  });

  it("builds SELECT with GROUP BY", () => {
    const q = QueryBuilder.select("orders")
      .columns("status", "COUNT(*)")
      .groupBy("status")
      .build();
    expect(q.sql).toBe("SELECT status, COUNT(*) FROM orders GROUP BY status");
  });

  it("builds SELECT with GROUP BY and HAVING", () => {
    const q = QueryBuilder.select("orders")
      .columns("status", "COUNT(*) as cnt")
      .groupBy("status")
      .having(col("cnt").gt(5))
      .build();
    expect(q.sql).toBe(
      "SELECT status, COUNT(*) as cnt FROM orders GROUP BY status HAVING cnt > $1",
    );
    expect(q.params).toEqual([5]);
  });

  it("builds SELECT with JOIN", () => {
    const q = QueryBuilder.select("users")
      .join("INNER", "orders", "users.id = orders.user_id")
      .build();
    expect(q.sql).toBe(
      "SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id",
    );
  });

  it("builds SELECT with LEFT JOIN", () => {
    const q = QueryBuilder.select("users")
      .join("LEFT", "profiles", "users.id = profiles.user_id")
      .build();
    expect(q.sql).toBe(
      "SELECT * FROM users LEFT JOIN profiles ON users.id = profiles.user_id",
    );
  });

  it("builds SELECT with multiple JOINs", () => {
    const q = QueryBuilder.select("users")
      .join("INNER", "orders", "users.id = orders.user_id")
      .join("LEFT", "addresses", "users.id = addresses.user_id")
      .build();
    expect(q.sql).toBe(
      "SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id LEFT JOIN addresses ON users.id = addresses.user_id",
    );
  });

  it("builds complex SELECT with all clauses", () => {
    const q = QueryBuilder.select("users")
      .columns("user_name", "age")
      .join("INNER", "orders", "users.id = orders.user_id")
      .where(col("age").gt(18))
      .and(col("user_name").like("J%"))
      .orderBy("user_name", "ASC")
      .limit(10)
      .offset(20)
      .build();
    expect(q.sql).toBe(
      "SELECT user_name, age FROM users INNER JOIN orders ON users.id = orders.user_id WHERE (age > $1 AND user_name LIKE $2) ORDER BY user_name ASC LIMIT $3 OFFSET $4",
    );
    expect(q.params).toEqual([18, "J%", 10, 20]);
  });

  it("supports compound criteria with and/or/not helpers", () => {
    const criteria = and(
      col("age").gt(18),
      or(col("status").eq("active"), not(col("banned").eq(true))),
    );
    const q = QueryBuilder.select("users").where(criteria).build();
    expect(q.sql).toBe(
      "SELECT * FROM users WHERE (age > $1 AND (status = $2 OR NOT (banned = $3)))",
    );
    expect(q.params).toEqual([18, "active", true]);
  });

  it("supports IN criteria", () => {
    const q = QueryBuilder.select("users")
      .where(col("id").in([1, 2, 3]))
      .build();
    expect(q.sql).toBe("SELECT * FROM users WHERE id IN ($1, $2, $3)");
    expect(q.params).toEqual([1, 2, 3]);
  });

  it("supports BETWEEN criteria", () => {
    const q = QueryBuilder.select("users")
      .where(col("age").between(18, 65))
      .build();
    expect(q.sql).toBe("SELECT * FROM users WHERE age BETWEEN $1 AND $2");
    expect(q.params).toEqual([18, 65]);
  });

  it("supports IS NULL and IS NOT NULL", () => {
    const q = QueryBuilder.select("users")
      .where(col("deleted_at").isNull())
      .and(col("email").isNotNull())
      .build();
    expect(q.sql).toBe(
      "SELECT * FROM users WHERE (deleted_at IS NULL AND email IS NOT NULL)",
    );
    expect(q.params).toEqual([]);
  });

  it("and() on empty where sets the criteria", () => {
    const q = QueryBuilder.select("users")
      .and(col("age").gt(18))
      .build();
    expect(q.sql).toBe("SELECT * FROM users WHERE age > $1");
    expect(q.params).toEqual([18]);
  });

  it("or() on empty where sets the criteria", () => {
    const q = QueryBuilder.select("users")
      .or(col("age").gt(18))
      .build();
    expect(q.sql).toBe("SELECT * FROM users WHERE age > $1");
    expect(q.params).toEqual([18]);
  });
});

describe("QueryBuilder.insert", () => {
  it("builds a simple INSERT", () => {
    const q = QueryBuilder.insert("users")
      .set("name", "Alice")
      .set("age", 30)
      .build();
    expect(q.sql).toBe("INSERT INTO users (name, age) VALUES ($1, $2)");
    expect(q.params).toEqual(["Alice", 30]);
  });

  it("builds INSERT with values()", () => {
    const q = QueryBuilder.insert("users")
      .values({ name: "Bob", age: 25 })
      .build();
    expect(q.sql).toBe("INSERT INTO users (name, age) VALUES ($1, $2)");
    expect(q.params).toEqual(["Bob", 25]);
  });

  it("builds INSERT with RETURNING", () => {
    const q = QueryBuilder.insert("users")
      .set("name", "Alice")
      .returning("id")
      .build();
    expect(q.sql).toBe(
      "INSERT INTO users (name) VALUES ($1) RETURNING id",
    );
    expect(q.params).toEqual(["Alice"]);
  });

  it("builds INSERT with entity class", () => {
    const q = QueryBuilder.insert(User)
      .values({ user_name: "Charlie", email_address: "c@test.com", age: 28 })
      .returning("id")
      .build();
    expect(q.sql).toBe(
      "INSERT INTO users (user_name, email_address, age) VALUES ($1, $2, $3) RETURNING id",
    );
    expect(q.params).toEqual(["Charlie", "c@test.com", 28]);
  });

  it("builds INSERT with multiple RETURNING columns", () => {
    const q = QueryBuilder.insert("users")
      .set("name", "Alice")
      .returning("id", "created_at")
      .build();
    expect(q.sql).toBe(
      "INSERT INTO users (name) VALUES ($1) RETURNING id, created_at",
    );
  });
});

describe("QueryBuilder.update", () => {
  it("builds a simple UPDATE", () => {
    const q = QueryBuilder.update("users")
      .set("name", "Alice")
      .where(col("id").eq(1))
      .build();
    expect(q.sql).toBe("UPDATE users SET name = $1 WHERE id = $2");
    expect(q.params).toEqual(["Alice", 1]);
  });

  it("builds UPDATE with multiple SET", () => {
    const q = QueryBuilder.update("users")
      .set("name", "Alice")
      .set("age", 31)
      .where(col("id").eq(1))
      .build();
    expect(q.sql).toBe(
      "UPDATE users SET name = $1, age = $2 WHERE id = $3",
    );
    expect(q.params).toEqual(["Alice", 31, 1]);
  });

  it("builds UPDATE with values()", () => {
    const q = QueryBuilder.update("users")
      .values({ name: "Alice", age: 31 })
      .where(col("id").eq(1))
      .build();
    expect(q.sql).toBe(
      "UPDATE users SET name = $1, age = $2 WHERE id = $3",
    );
    expect(q.params).toEqual(["Alice", 31, 1]);
  });

  it("builds UPDATE with AND in WHERE", () => {
    const q = QueryBuilder.update("users")
      .set("active", false)
      .where(col("age").lt(18))
      .and(col("verified").eq(false))
      .build();
    expect(q.sql).toBe(
      "UPDATE users SET active = $1 WHERE (age < $2 AND verified = $3)",
    );
    expect(q.params).toEqual([false, 18, false]);
  });

  it("builds UPDATE with RETURNING", () => {
    const q = QueryBuilder.update("users")
      .set("name", "Alice")
      .where(col("id").eq(1))
      .returning("*")
      .build();
    expect(q.sql).toBe(
      "UPDATE users SET name = $1 WHERE id = $2 RETURNING *",
    );
  });

  it("builds UPDATE without WHERE", () => {
    const q = QueryBuilder.update("users").set("active", false).build();
    expect(q.sql).toBe("UPDATE users SET active = $1");
    expect(q.params).toEqual([false]);
  });

  it("builds UPDATE with entity class", () => {
    const q = QueryBuilder.update(User)
      .set("user_name", "Updated")
      .where(col("id").eq(1))
      .build();
    expect(q.sql).toBe("UPDATE users SET user_name = $1 WHERE id = $2");
    expect(q.params).toEqual(["Updated", 1]);
  });

  it("and() on empty where sets the criteria", () => {
    const q = QueryBuilder.update("users")
      .set("active", false)
      .and(col("id").eq(1))
      .build();
    expect(q.sql).toBe("UPDATE users SET active = $1 WHERE id = $2");
    expect(q.params).toEqual([false, 1]);
  });
});

describe("QueryBuilder.delete", () => {
  it("builds a simple DELETE", () => {
    const q = QueryBuilder.delete("users")
      .where(col("id").eq(1))
      .build();
    expect(q.sql).toBe("DELETE FROM users WHERE id = $1");
    expect(q.params).toEqual([1]);
  });

  it("builds DELETE with compound WHERE", () => {
    const q = QueryBuilder.delete("users")
      .where(col("active").eq(false))
      .and(col("age").lt(18))
      .build();
    expect(q.sql).toBe(
      "DELETE FROM users WHERE (active = $1 AND age < $2)",
    );
    expect(q.params).toEqual([false, 18]);
  });

  it("builds DELETE with RETURNING", () => {
    const q = QueryBuilder.delete("users")
      .where(col("id").eq(1))
      .returning("id", "name")
      .build();
    expect(q.sql).toBe(
      "DELETE FROM users WHERE id = $1 RETURNING id, name",
    );
  });

  it("builds DELETE without WHERE", () => {
    const q = QueryBuilder.delete("users").build();
    expect(q.sql).toBe("DELETE FROM users");
    expect(q.params).toEqual([]);
  });

  it("builds DELETE with entity class", () => {
    const q = QueryBuilder.delete(User)
      .where(col("id").eq(42))
      .build();
    expect(q.sql).toBe("DELETE FROM users WHERE id = $1");
    expect(q.params).toEqual([42]);
  });

  it("and() on empty where sets the criteria", () => {
    const q = QueryBuilder.delete("users")
      .and(col("id").eq(1))
      .build();
    expect(q.sql).toBe("DELETE FROM users WHERE id = $1");
    expect(q.params).toEqual([1]);
  });
});
