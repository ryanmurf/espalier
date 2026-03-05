# Bundle Size Report

Generated after Y4 Q1 tree-shaking and lazy loading optimizations.

## Entry Point Sizes (gzipped)

| Package | Gzipped | Budget | Status |
|---------|---------|--------|--------|
| espalier-jdbc | 11.9 KB | 15 KB | OK |
| espalier-data (full index) | 1.91 KB | 15 KB | OK |
| espalier-data/core | 912 B | 50 KB | OK |
| espalier-data/relations | 151 B | 5 KB | OK |
| espalier-data/tenant | 328 B | 5 KB | OK |
| espalier-data/observability | 127 B | 5 KB | OK |
| espalier-data/graphql | 226 B | 5 KB | OK |
| espalier-data/rest | 242 B | 5 KB | OK |
| espalier-data/plugins | 207 B | 5 KB | OK |
| espalier-proxy | 1.95 KB | 5 KB | OK |

## Total Package Sizes (all ESM chunks, gzipped)

| Package | Raw | Gzipped |
|---------|-----|---------|
| espalier-jdbc | 54.6 KB | 11.9 KB |
| espalier-data (all chunks) | 278 KB | 46.8 KB |
| espalier-proxy | 5.2 KB | 1.95 KB |

## Architecture

- **Code splitting**: tsup splits shared code into chunks; entry points are thin re-export shims
- **Lazy loading**: GraphQL, REST, and observability subsystems use dynamic `import()` from the root index — not loaded until first use
- **Subpath exports**: `espalier-data/core`, `espalier-data/relations`, etc. allow importing only what you need
- **sideEffects: false**: All packages marked for bundler tree-shaking

## Running Size Checks

```bash
# Check all budgets
pnpm run size

# JSON report
pnpm run size:report
```

Budget configuration: `.size-limit.json`
