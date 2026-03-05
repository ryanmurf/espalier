# Hono Starter

## Quick Start

```bash
npm create hono@latest my-api
cd my-api
npm install espalier-data espalier-jdbc espalier-jdbc-pg
```

## Project Structure

```
my-api/
├── src/
│   ├── entities/
│   │   └── todo.ts
│   ├── repositories/
│   │   └── todo-repository.ts
│   ├── middleware/
│   │   └── db.ts
│   └── index.ts
└── package.json
```

## Database Middleware

```typescript
// src/middleware/db.ts
import { createMiddleware } from "hono/factory";
import { PgDataSource } from "espalier-jdbc-pg";
import type { Connection } from "espalier-jdbc";

const dataSource = new PgDataSource({
  host: process.env.DB_HOST!,
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
});

type DbEnv = { Variables: { conn: Connection } };

export const dbMiddleware = createMiddleware<DbEnv>(async (c, next) => {
  const conn = await dataSource.getConnection();
  c.set("conn", conn);
  try {
    await next();
  } finally {
    await conn.close();
  }
});
```

## Entity & Repository

```typescript
// src/entities/todo.ts
import { Entity, Id, Column, Table } from "espalier-data";

@Entity()
@Table("todos")
export class Todo {
  @Id() @Column() id!: string;
  @Column() title!: string;
  @Column({ type: "BOOLEAN" }) completed!: boolean;
}

// src/repositories/todo-repository.ts
import { createRepository } from "espalier-data";
import { Todo } from "../entities/todo.js";

interface TodoRepo {
  findById(id: string): Promise<Todo | null>;
  findByCompleted(completed: boolean): Promise<Todo[]>;
  save(todo: Todo): Promise<Todo>;
  delete(todo: Todo): Promise<void>;
}

export const todoRepo = createRepository<Todo, TodoRepo>(Todo);
```

## Routes

```typescript
// src/index.ts
import { Hono } from "hono";
import { dbMiddleware } from "./middleware/db.js";
import { todoRepo } from "./repositories/todo-repository.js";
import { Todo } from "./entities/todo.js";

const app = new Hono();
app.use("/api/*", dbMiddleware);

app.get("/api/todos", async (c) => {
  const todos = await todoRepo.findByCompleted(c.get("conn"), false);
  return c.json(todos);
});

app.post("/api/todos", async (c) => {
  const body = await c.req.json();
  const todo = new Todo();
  todo.id = crypto.randomUUID();
  todo.title = body.title;
  todo.completed = false;
  const saved = await todoRepo.save(c.get("conn"), todo);
  return c.json(saved, 201);
});

export default app;
```
