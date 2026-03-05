import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");
const pkgJson = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));

const distExists = () => existsSync(resolve(pkgRoot, "dist/index.js"));
const readDist = (name: string) => readFileSync(resolve(pkgRoot, `dist/${name}`), "utf8");

// ==========================================================================
// Package.json validation
// ==========================================================================

describe("package.json — structure", () => {
  it("has correct package name", () => {
    expect(pkgJson.name).toBe("espalier-testing");
  });

  it("is an ESM package", () => {
    expect(pkgJson.type).toBe("module");
  });

  it("declares sideEffects: false for tree-shaking", () => {
    expect(pkgJson.sideEffects).toBe(false);
  });

  it("has both CJS and ESM entry points", () => {
    expect(pkgJson.main).toMatch(/\.cjs$/);
    expect(pkgJson.module).toMatch(/\.js$/);
  });

  it("has types entry point", () => {
    expect(pkgJson.types).toBeDefined();
    expect(pkgJson.types).toMatch(/\.d\.ts$/);
  });

  it("has exports field with import and require conditions", () => {
    expect(pkgJson.exports).toBeDefined();
    expect(pkgJson.exports["."]).toBeDefined();
    expect(pkgJson.exports["."].import).toBeDefined();
    expect(pkgJson.exports["."].require).toBeDefined();
  });

  it("exports import has types and default", () => {
    const imp = pkgJson.exports["."].import;
    expect(imp.types).toMatch(/\.d\.ts$/);
    expect(imp.default).toMatch(/\.js$/);
  });

  it("exports require has types and default", () => {
    const req = pkgJson.exports["."].require;
    expect(req.types).toMatch(/\.d\.cts$/);
    expect(req.default).toMatch(/\.cjs$/);
  });

  it("files field only includes dist", () => {
    expect(pkgJson.files).toEqual(["dist"]);
  });

  it("has build, typecheck, and clean scripts", () => {
    expect(pkgJson.scripts.build).toBeDefined();
    expect(pkgJson.scripts.typecheck).toBeDefined();
    expect(pkgJson.scripts.clean).toBeDefined();
  });
});

describe("package.json — peer dependencies", () => {
  it("declares espalier-jdbc as peer dependency", () => {
    expect(pkgJson.peerDependencies).toBeDefined();
    expect(pkgJson.peerDependencies["espalier-jdbc"]).toBeDefined();
  });

  it("declares espalier-data as peer dependency", () => {
    expect(pkgJson.peerDependencies["espalier-data"]).toBeDefined();
  });

  it("has peer dependencies also in devDependencies for development", () => {
    expect(pkgJson.devDependencies["espalier-jdbc"]).toBeDefined();
    expect(pkgJson.devDependencies["espalier-data"]).toBeDefined();
  });

  it("peer dependencies use workspace protocol in devDependencies", () => {
    expect(pkgJson.devDependencies["espalier-jdbc"]).toMatch(/^workspace:/);
    expect(pkgJson.devDependencies["espalier-data"]).toMatch(/^workspace:/);
  });

  it("does NOT declare vitest as dependency (it is a root dev dep)", () => {
    expect(pkgJson.dependencies?.vitest).toBeUndefined();
    expect(pkgJson.peerDependencies?.vitest).toBeUndefined();
  });
});

// ==========================================================================
// tsconfig validation
// ==========================================================================

describe("tsconfig.json — structure", () => {
  const tsconfig = JSON.parse(readFileSync(resolve(pkgRoot, "tsconfig.json"), "utf8"));

  it("extends root tsconfig.base.json", () => {
    expect(tsconfig.extends).toMatch(/tsconfig\.base\.json/);
  });

  it("has outDir and rootDir set", () => {
    expect(tsconfig.compilerOptions.outDir).toBeDefined();
    expect(tsconfig.compilerOptions.rootDir).toBeDefined();
  });

  it("includes src directory", () => {
    expect(tsconfig.include).toContain("src");
  });
});

// ==========================================================================
// Build output validation
// ==========================================================================

describe.skipIf(!distExists())("dist output — file existence", () => {
  it("ESM output exists", () => {
    expect(existsSync(resolve(pkgRoot, "dist/index.js"))).toBe(true);
  });

  it("CJS output exists", () => {
    expect(existsSync(resolve(pkgRoot, "dist/index.cjs"))).toBe(true);
  });

  it("ESM declaration exists", () => {
    expect(existsSync(resolve(pkgRoot, "dist/index.d.ts"))).toBe(true);
  });

  it("CJS declaration exists", () => {
    expect(existsSync(resolve(pkgRoot, "dist/index.d.cts"))).toBe(true);
  });

  it("source maps exist", () => {
    expect(existsSync(resolve(pkgRoot, "dist/index.js.map"))).toBe(true);
    expect(existsSync(resolve(pkgRoot, "dist/index.cjs.map"))).toBe(true);
  });
});

describe.skipIf(!distExists())("dist output — ESM bundle content", () => {
  it("exports EntityFactory", () => {
    expect(readDist("index.js")).toContain("EntityFactory");
  });

  it("exports SeedRunner", () => {
    expect(readDist("index.js")).toContain("SeedRunner");
  });

  it("exports withTestTransaction", () => {
    expect(readDist("index.js")).toContain("withTestTransaction");
  });

  it("exports QueryLog", () => {
    expect(readDist("index.js")).toContain("QueryLog");
  });

  it("uses ES export syntax", () => {
    expect(readDist("index.js")).toMatch(/export\s*\{/);
  });

  it("does NOT contain require() calls (pure ESM)", () => {
    expect(readDist("index.js")).not.toMatch(/\brequire\s*\(/);
  });
});

describe.skipIf(!distExists())("dist output — CJS bundle content", () => {
  it("exports via module.exports or exports", () => {
    const cjsContent = readDist("index.cjs");
    expect(
      cjsContent.includes("module.exports") || cjsContent.includes("exports.")
    ).toBe(true);
  });
});

describe.skipIf(!distExists() || !existsSync(resolve(pkgRoot, "dist/index.d.ts")))(
  "dist output — declaration file content",
  () => {
    it("declares EntityFactory class with generic", () => {
      expect(readDist("index.d.ts")).toMatch(/class EntityFactory/);
    });

    it("declares SeedRunner class", () => {
      expect(readDist("index.d.ts")).toMatch(/class SeedRunner/);
    });

    it("declares withTestTransaction function", () => {
      expect(readDist("index.d.ts")).toMatch(/withTestTransaction/);
    });

    it("declares QueryLog class", () => {
      expect(readDist("index.d.ts")).toMatch(/class QueryLog/);
    });

    it("has export statement for core exports", () => {
      const dtsContent = readDist("index.d.ts");
      expect(dtsContent).toMatch(/export\s*\{.*EntityFactory/);
      expect(dtsContent).toMatch(/export\s*\{.*SeedRunner/);
      expect(dtsContent).toMatch(/export\s*\{.*withTestTransaction/);
      expect(dtsContent).toMatch(/export\s*\{.*QueryLog/);
    });
  },
);

// ==========================================================================
// Import resolution (runtime — from source, not dist)
// ==========================================================================

describe("import resolution — ESM imports work", () => {
  it("can import EntityFactory from package", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.EntityFactory).toBeDefined();
    expect(typeof mod.EntityFactory).toBe("function");
  });

  it("can import SeedRunner from package", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.SeedRunner).toBeDefined();
  });

  it("can import withTestTransaction from package", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.withTestTransaction).toBeDefined();
  });

  it("can import QueryLog from package", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.QueryLog).toBeDefined();
  });
});

// ==========================================================================
// Placeholder implementations — basic sanity
// ==========================================================================

describe("core implementations — basic sanity", () => {
  it("SeedRunner is a class", async () => {
    const { SeedRunner } = await import("../../src/index.js");
    expect(typeof SeedRunner).toBe("function");
  });

  it("withTestTransaction is a function", async () => {
    const { withTestTransaction } = await import("../../src/index.js");
    expect(typeof withTestTransaction).toBe("function");
  });

  it("QueryLog is a class", async () => {
    const { QueryLog } = await import("../../src/index.js");
    expect(typeof QueryLog).toBe("function");
    const log = new QueryLog();
    expect(log.count).toBe(0);
  });

  it("assertQueryCount is a function", async () => {
    const { assertQueryCount } = await import("../../src/index.js");
    expect(typeof assertQueryCount).toBe("function");
  });
});

// ==========================================================================
// Source file structure validation
// ==========================================================================

describe("source structure — .js extension imports", () => {
  const indexSource = readFileSync(resolve(pkgRoot, "src/index.ts"), "utf8");

  it("all imports use .js extensions (verbatimModuleSyntax compliance)", () => {
    const importLines = indexSource.split("\n").filter((line) => line.match(/^export .* from /));
    for (const line of importLines) {
      expect(line).toMatch(/\.js["'];\s*$/);
    }
  });

  it("does NOT use legacy decorator patterns (reflect-metadata)", () => {
    const allSources = [
      readFileSync(resolve(pkgRoot, "src/index.ts"), "utf8"),
      readFileSync(resolve(pkgRoot, "src/factory/entity-factory.ts"), "utf8"),
      readFileSync(resolve(pkgRoot, "src/seeding/seeder.ts"), "utf8"),
      readFileSync(resolve(pkgRoot, "src/isolation/test-transaction.ts"), "utf8"),
      readFileSync(resolve(pkgRoot, "src/assertions/query-assertions.ts"), "utf8"),
    ].join("\n");
    expect(allSources).not.toContain("reflect-metadata");
    expect(allSources).not.toContain("Reflect.getMetadata");
    expect(allSources).not.toContain("Reflect.defineMetadata");
  });
});

// ==========================================================================
// No circular dependencies (basic check)
// ==========================================================================

describe("circular dependency — basic check", () => {
  it("factory does not import from assertions/seeder/isolation", () => {
    const src = readFileSync(resolve(pkgRoot, "src/factory/entity-factory.ts"), "utf8");
    expect(src).not.toContain("../assertions");
    expect(src).not.toContain("../seeding");
    expect(src).not.toContain("../isolation");
  });

  it("seeder does not import from assertions/isolation", () => {
    const src = readFileSync(resolve(pkgRoot, "src/seeding/seeder.ts"), "utf8");
    expect(src).not.toContain("../assertions");
    expect(src).not.toContain("../isolation");
  });

  it("index.ts only re-exports, does not contain business logic", () => {
    const src = readFileSync(resolve(pkgRoot, "src/index.ts"), "utf8");
    const nonCommentLines = src
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**"));
    for (const line of nonCommentLines) {
      // Lines must be export statements or continuation of multi-line exports (e.g. "  SeedRunner,")
      expect(line).toMatch(/^export |^\s+\w|^\s*}\s*from\s/);
    }
  });

  it("all exports from index.ts include the core scaffold classes", async () => {
    const mod = await import("../../src/index.js");
    const exportNames = Object.keys(mod);
    // Core scaffold classes must always be present
    expect(exportNames).toContain("EntityFactory");
    expect(exportNames).toContain("SeedRunner");
    expect(exportNames).toContain("withTestTransaction");
    expect(exportNames).toContain("QueryLog");
  });
});

// ==========================================================================
// Tree-shakeability
// ==========================================================================

describe.skipIf(!distExists())("tree-shakeability", () => {
  it("ESM bundle has no top-level side effects (IIFE, global mutations)", () => {
    const esmContent = readDist("index.js");
    expect(esmContent).not.toMatch(/\(\s*function\s*\(\s*\)\s*\{/);
    expect(esmContent).not.toContain("globalThis.");
    expect(esmContent).not.toContain("window.");
    expect(esmContent).not.toMatch(/\bglobal\./);
  });
});
