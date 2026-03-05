# Fastify Starter

## Quick Start

```bash
mkdir my-api && cd my-api
npm init -y
npm install fastify espalier-data espalier-jdbc espalier-jdbc-pg
npm install -D typescript @types/node
```

## Project Structure

```
my-api/
├── src/
│   ├── entities/
│   │   └── product.ts
│   ├── repositories/
│   │   └── product-repository.ts
│   ├── plugins/
│   │   └── db.ts
│   ├── routes/
│   │   └── products.ts
│   └── server.ts
└── package.json
```

## Database Plugin

```typescript
// src/plugins/db.ts
import fp from "fastify-plugin";
import { PgDataSource } from "espalier-jdbc-pg";
import type { FastifyInstance } from "fastify";
import type { DataSource } from "espalier-jdbc";

declare module "fastify" {
  interface FastifyInstance {
    db: DataSource;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const dataSource = new PgDataSource({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "myapp",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  });

  fastify.decorate("db", dataSource);
  fastify.addHook("onClose", async () => dataSource.close());
});
```

## Routes

```typescript
// src/routes/products.ts
import type { FastifyInstance } from "fastify";
import { productRepo } from "../repositories/product-repository.js";
import { Product } from "../entities/product.js";

export default async function productRoutes(fastify: FastifyInstance) {
  fastify.get("/products", async (request, reply) => {
    const conn = await fastify.db.getConnection();
    try {
      const products = await productRepo.findAll(conn);
      return products;
    } finally {
      await conn.close();
    }
  });

  fastify.post("/products", async (request, reply) => {
    const body = request.body as { name: string; price: number };
    const conn = await fastify.db.getConnection();
    try {
      const product = new Product();
      product.id = crypto.randomUUID();
      product.name = body.name;
      product.price = body.price;
      const saved = await productRepo.save(conn, product);
      reply.code(201).send(saved);
    } finally {
      await conn.close();
    }
  });
}
```

## Server

```typescript
// src/server.ts
import Fastify from "fastify";
import dbPlugin from "./plugins/db.js";
import productRoutes from "./routes/products.js";

const server = Fastify({ logger: true });

server.register(dbPlugin);
server.register(productRoutes, { prefix: "/api" });

server.listen({ port: 3000, host: "0.0.0.0" }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
});
```
