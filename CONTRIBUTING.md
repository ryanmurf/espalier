# Contributing to Espalier

Thank you for your interest in contributing to Espalier! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20+ (or Bun 1.x / Deno 2.x)
- pnpm 9+
- PostgreSQL (for integration tests)

### Getting Started

```bash
git clone https://github.com/espalier-orm/espalier.git
cd espalier
pnpm install
pnpm build
pnpm test
```

### Project Structure

```
espalier/
├── packages/
│   ├── jdbc/           # Core JDBC interfaces
│   ├── data/           # Entity decorators, repositories, query builder
│   ├── jdbc-pg/        # PostgreSQL adapter
│   ├── mysql/          # MySQL adapter
│   ├── sqlite/         # SQLite adapter
│   ├── d1/             # Cloudflare D1 adapter
│   ├── libsql/         # LibSQL/Turso adapter
│   ├── cli/            # Migration CLI
│   ├── testing/        # Test utilities
│   ├── studio/         # Web-based data browser
│   ├── event-sourcing/ # Event sourcing & CQRS
│   ├── realtime/       # Change streams & SSE
│   ├── playground/     # Interactive sandbox
│   ├── next/           # Next.js adapter
│   ├── proxy/          # Connection pooling proxy
│   └── migrate-prisma/ # Prisma migration tool
├── docs/               # Documentation
└── CHANGELOG.md
```

## Development Workflow

### Building

```bash
pnpm build              # Build all packages
pnpm --filter espalier-data build  # Build specific package
```

### Testing

```bash
pnpm test               # Run all tests
pnpm --filter espalier-data exec vitest run  # Test specific package
```

### Code Style

- **TypeScript 5.x** with TC39 standard decorators (NOT `experimentalDecorators`)
- **`verbatimModuleSyntax`** — use `import type` for type-only imports
- **`.js` extensions** in relative imports (ESM)
- Keep it simple — avoid over-engineering

### Commit Messages

We use conventional commits:

```
feat: add new feature
fix: resolve bug
docs: update documentation
test: add tests
refactor: restructure code
chore: maintenance tasks
```

## Making Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Add tests for new functionality
5. Run `pnpm build && pnpm test` to verify
6. Commit with a conventional commit message
7. Push and open a pull request

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality
- Update documentation if adding new public APIs
- Ensure all tests pass
- Describe what the PR does and why

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- Include TypeScript and Node.js versions

## Code of Conduct

Be respectful and constructive. We're all here to build something great.

## License

By contributing, you agree that your contributions will be licensed under the project's MIT license.
