# Next.js App Router Starter

## Quick Start

```bash
npx create-next-app@latest my-app --typescript
cd my-app
npm install espalier-data espalier-jdbc espalier-jdbc-pg @espalier/next
```

## Project Structure

```
my-app/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   └── users/
│   │   │       └── route.ts
│   │   ├── users/
│   │   │   ├── page.tsx
│   │   │   └── [id]/page.tsx
│   │   └── layout.tsx
│   ├── entities/
│   │   └── user.ts
│   ├── repositories/
│   │   └── user-repository.ts
│   └── lib/
│       └── db.ts
├── migrations/
│   └── 20260101000000_create_users.ts
└── package.json
```

## Database Configuration

```typescript
// src/lib/db.ts
import { PgDataSource } from "espalier-jdbc-pg";
import { createEspalierNext } from "@espalier/next";

const dataSource = new PgDataSource({
  host: process.env.DB_HOST!,
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
});

export const { withConnection, withTransaction } = createEspalierNext(dataSource);
export { dataSource };
```

## Entity Definition

```typescript
// src/entities/user.ts
import { Entity, Id, Column, Table, Version } from "espalier-data";

@Entity()
@Table("users")
export class User {
  @Id()
  @Column()
  id!: string;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ type: "BOOLEAN" })
  active!: boolean;

  @Version()
  version!: number;
}
```

## Repository

```typescript
// src/repositories/user-repository.ts
import { createRepository } from "espalier-data";
import { User } from "../entities/user.js";

interface UserRepo {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByActive(active: boolean): Promise<User[]>;
  save(user: User): Promise<User>;
  delete(user: User): Promise<void>;
}

export const userRepository = createRepository<User, UserRepo>(User);
```

## API Route

```typescript
// src/app/api/users/route.ts
import { NextResponse } from "next/server";
import { withConnection } from "@/lib/db";
import { userRepository } from "@/repositories/user-repository";

export async function GET() {
  return withConnection(async (conn) => {
    const users = await userRepository.findByActive(conn, true);
    return NextResponse.json(users);
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  return withTransaction(async (conn) => {
    const user = new User();
    user.id = crypto.randomUUID();
    user.name = body.name;
    user.email = body.email;
    user.active = true;
    const saved = await userRepository.save(conn, user);
    return NextResponse.json(saved, { status: 201 });
  });
}
```

## Server Component

```typescript
// src/app/users/page.tsx
import { withConnection } from "@/lib/db";
import { userRepository } from "@/repositories/user-repository";

export default async function UsersPage() {
  const users = await withConnection(async (conn) => {
    return userRepository.findByActive(conn, true);
  });

  return (
    <div>
      <h1>Users</h1>
      <ul>
        {users.map(user => (
          <li key={user.id}>{user.name} ({user.email})</li>
        ))}
      </ul>
    </div>
  );
}
```

## Environment Variables

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=myapp
DB_USER=postgres
DB_PASSWORD=secret
```
