import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════════
// Adversarial tests for tree-shakeable package architecture
// Tests: subpath exports, sideEffects, backward compat, decorators
// ═══════════════════════════════════════════════════════════════

const PKG_ROOT = path.resolve(import.meta.dirname, "../../../");
const DIST_DIR = path.join(PKG_ROOT, "dist");

describe("tree-shakeable architecture adversarial tests", () => {
  // ──────────────────────────────────────────────
  // 1. package.json structural validation
  // ──────────────────────────────────────────────

  describe("package.json structure", () => {
    let pkg: any;

    it("package.json exists and parses", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      expect(pkg).toBeDefined();
    });

    it("sideEffects is false", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      expect(pkg.sideEffects).toBe(false);
    });

    it("exports field exists with root entry", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      expect(pkg.exports).toBeDefined();
      expect(pkg.exports["."]).toBeDefined();
    });

    it("all subpath exports point to existing dist files", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);

      for (const [subpath, conditions] of Object.entries(pkg.exports as Record<string, any>)) {
        const esmEntry = conditions?.import?.default;
        const cjsEntry = conditions?.require?.default;
        const esmTypes = conditions?.import?.types;
        const cjsTypes = conditions?.require?.types;

        if (esmEntry) {
          const fullPath = path.join(PKG_ROOT, esmEntry);
          expect(
            fs.existsSync(fullPath),
            `ESM entry ${esmEntry} for subpath "${subpath}" does not exist at ${fullPath}`,
          ).toBe(true);
        }

        if (cjsEntry) {
          const fullPath = path.join(PKG_ROOT, cjsEntry);
          expect(
            fs.existsSync(fullPath),
            `CJS entry ${cjsEntry} for subpath "${subpath}" does not exist at ${fullPath}`,
          ).toBe(true);
        }

        if (esmTypes) {
          const fullPath = path.join(PKG_ROOT, esmTypes);
          expect(
            fs.existsSync(fullPath),
            `ESM types ${esmTypes} for subpath "${subpath}" does not exist at ${fullPath}`,
          ).toBe(true);
        }

        if (cjsTypes) {
          const fullPath = path.join(PKG_ROOT, cjsTypes);
          expect(
            fs.existsSync(fullPath),
            `CJS types ${cjsTypes} for subpath "${subpath}" does not exist at ${fullPath}`,
          ).toBe(true);
        }
      }
    });

    it("all expected subpaths are present", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      const expected = [".", "./core", "./relations", "./tenant", "./observability", "./graphql", "./rest", "./plugins"];
      for (const sp of expected) {
        expect(
          pkg.exports[sp],
          `Missing subpath export: ${sp}`,
        ).toBeDefined();
      }
    });

    it("each subpath has both import and require conditions", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      for (const [subpath, conditions] of Object.entries(pkg.exports as Record<string, any>)) {
        expect(
          conditions.import,
          `Subpath "${subpath}" missing "import" condition`,
        ).toBeDefined();
        expect(
          conditions.require,
          `Subpath "${subpath}" missing "require" condition`,
        ).toBeDefined();
      }
    });

    it("each subpath import condition has types and default", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      for (const [subpath, conditions] of Object.entries(pkg.exports as Record<string, any>)) {
        expect(
          conditions.import.types,
          `Subpath "${subpath}" import missing "types"`,
        ).toBeDefined();
        expect(
          conditions.import.default,
          `Subpath "${subpath}" import missing "default"`,
        ).toBeDefined();
      }
    });

    it("no wildcard subpath exports (would leak internals)", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      pkg = JSON.parse(raw);
      const subpaths = Object.keys(pkg.exports);
      for (const sp of subpaths) {
        expect(sp).not.toContain("*");
      }
    });
  });

  // ──────────────────────────────────────────────
  // 2. Subpath exports — verify exports exist
  // ──────────────────────────────────────────────

  describe("subpath export modules resolve", () => {
    it("espalier-data/core exports core symbols", async () => {
      const core = await import("../../core.js");
      expect(core.Table).toBeDefined();
      expect(core.Column).toBeDefined();
      expect(core.Id).toBeDefined();
      expect(core.Repository).toBeDefined();
      expect(core.createAutoRepository).toBeDefined();
      expect(core.createPageable).toBeDefined();
      expect(core.createPage).toBeDefined();
      expect(core.SelectBuilder).toBeDefined();
      expect(core.QueryBuilder).toBeDefined();
      expect(core.EntityCache).toBeDefined();
      expect(core.QueryCache).toBeDefined();
      expect(core.DdlGenerator).toBeDefined();
      expect(core.EventBus).toBeDefined();
    });

    it("espalier-data/relations exports relation decorators", async () => {
      const rel = await import("../../relations.js");
      expect(rel.ManyToOne).toBeDefined();
      expect(rel.OneToMany).toBeDefined();
      expect(rel.ManyToMany).toBeDefined();
      expect(rel.OneToOne).toBeDefined();
      expect(rel.getManyToOneRelations).toBeDefined();
      expect(rel.getOneToManyRelations).toBeDefined();
      expect(rel.getManyToManyRelations).toBeDefined();
      expect(rel.getOneToOneRelations).toBeDefined();
    });

    it("espalier-data/tenant exports tenant symbols", async () => {
      const tenant = await import("../../tenant-entry.js");
      expect(tenant.TenantContext).toBeDefined();
      expect(tenant.TenantAwareDataSource).toBeDefined();
      expect(tenant.TenantId).toBeDefined();
      expect(tenant.RoutingDataSource).toBeDefined();
      expect(tenant.ReadReplicaDataSource).toBeDefined();
      expect(tenant.TenantSchemaManager).toBeDefined();
      expect(tenant.tenantFilter).toBeDefined();
    });

    it("espalier-data/observability exports observability symbols", async () => {
      const obs = await import("../../observability-entry.js");
      expect(obs.configureObservability).toBeDefined();
      expect(typeof obs.configureObservability).toBe("function");
    });

    it("espalier-data/graphql exports graphql symbols", async () => {
      const gql = await import("../../graphql-entry.js");
      expect(gql.GraphQLSchemaGenerator).toBeDefined();
      expect(gql.GraphQLPlugin).toBeDefined();
      expect(gql.ResolverGenerator).toBeDefined();
      expect(gql.createFilterSpec).toBeDefined();
    });

    it("espalier-data/rest exports rest symbols", async () => {
      const rest = await import("../../rest-entry.js");
      expect(rest.RouteGenerator).toBeDefined();
      expect(rest.RestPlugin).toBeDefined();
      expect(rest.OpenApiGenerator).toBeDefined();
      expect(rest.mountExpressRoutes).toBeDefined();
      expect(rest.createFastifyPlugin).toBeDefined();
      expect(rest.customizeRoutes).toBeDefined();
      expect(rest.addHateoasLinks).toBeDefined();
    });

    it("espalier-data/plugins exports plugin symbols", async () => {
      const plugins = await import("../../plugins-entry.js");
      expect(plugins.PluginManager).toBeDefined();
      expect(plugins.PluginDecorator).toBeDefined();
      expect(plugins.composeMiddleware).toBeDefined();
      expect(plugins.createPluginDecorator).toBeDefined();
      expect(plugins.getPluginMetadata).toBeDefined();
      expect(plugins.getDiscoveredPlugins).toBeDefined();
      expect(plugins.clearDiscoveredPlugins).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────
  // 3. Root export backward compatibility
  // ──────────────────────────────────────────────

  describe("root export backward compatibility", () => {
    it("root index exports all core symbols", async () => {
      const root = await import("../../index.js");
      // Core
      expect(root.Table).toBeDefined();
      expect(root.Column).toBeDefined();
      expect(root.Id).toBeDefined();
      expect(root.Repository).toBeDefined();
      expect(root.createAutoRepository).toBeDefined();
      expect(root.createDerivedRepository).toBeDefined();
      expect(root.createRepository).toBeDefined();
    });

    it("root index exports relation decorators", async () => {
      const root = await import("../../index.js");
      expect(root.ManyToOne).toBeDefined();
      expect(root.OneToMany).toBeDefined();
      expect(root.ManyToMany).toBeDefined();
      expect(root.OneToOne).toBeDefined();
    });

    it("root index exports tenant symbols", async () => {
      const root = await import("../../index.js");
      expect(root.TenantContext).toBeDefined();
      expect(root.TenantAwareDataSource).toBeDefined();
      expect(root.TenantId).toBeDefined();
      expect(root.RoutingDataSource).toBeDefined();
    });

    it("root index exports plugin symbols", async () => {
      const root = await import("../../index.js");
      expect(root.PluginManager).toBeDefined();
      expect(root.PluginDecorator).toBeDefined();
    });

    it("root index exports lazy proxies for GraphQL/REST", async () => {
      const root = await import("../../index.js");
      // These are lazy proxies (not the real classes yet)
      expect(root.GraphQLSchemaGenerator).toBeDefined();
      expect(root.RouteGenerator).toBeDefined();
      expect(root.RestPlugin).toBeDefined();
      expect(root.OpenApiGenerator).toBeDefined();
    });

    it("root index exports lazy loader functions", async () => {
      const root = await import("../../index.js");
      expect(typeof root.loadGraphQLModule).toBe("function");
      expect(typeof root.loadRestModule).toBe("function");
      expect(typeof root.loadObservabilityModule).toBe("function");
      expect(typeof root.configureObservability).toBe("function");
    });
  });

  // ──────────────────────────────────────────────
  // 4. Decorator side effects with subpath imports
  // ──────────────────────────────────────────────

  describe("decorator side effects survive sideEffects: false", () => {
    it("@Table decorator stores metadata via WeakMap from core import", async () => {
      const { Table, getTableName } = await import("../../core.js");
      const { Column, getColumnMappings } = await import("../../core.js");
      const { Id, getIdField } = await import("../../core.js");

      @Table("test_widgets")
      class TestWidget {
        @Id @Column() id: number = 0;
        @Column() label: string = "";
      }

      // TC39 decorators with addInitializer require instance creation
      // to trigger the initializer that stores metadata
      new TestWidget();

      expect(getTableName(TestWidget)).toBe("test_widgets");
      expect(getIdField(TestWidget)).toBe("id");
      const cols = getColumnMappings(TestWidget);
      expect(cols.size).toBeGreaterThanOrEqual(2);
    });

    it("@ManyToOne from relations subpath stores relation metadata", async () => {
      const { Table } = await import("../../core.js");
      const { Column } = await import("../../core.js");
      const { Id } = await import("../../core.js");
      const { ManyToOne, getManyToOneRelations } = await import("../../relations.js");

      @Table("rel_parents")
      class RelParent {
        @Id @Column() id: number = 0;
      }

      @Table("rel_children")
      class RelChild {
        @Id @Column() id: number = 0;
        @ManyToOne({ target: () => RelParent }) parent!: RelParent;
      }

      // Instantiate to trigger addInitializer metadata registration
      new RelParent();
      new RelChild();

      const relations = getManyToOneRelations(RelChild);
      expect(relations.length).toBeGreaterThanOrEqual(1);
      expect(relations[0].fieldName).toBe("parent");
    });

    it("decorators from different subpaths share the same WeakMap metadata", async () => {
      const { Table, getTableName } = await import("../../core.js");
      const { Column } = await import("../../core.js");
      const { Id } = await import("../../core.js");

      // Also import from root — should be the same functions
      const rootModule = await import("../../index.js");

      @Table("shared_meta")
      class SharedMeta {
        @Id @Column() id: number = 0;
      }

      new SharedMeta(); // trigger addInitializer

      // Both paths should return the same metadata
      const fromCore = getTableName(SharedMeta);
      const fromRoot = rootModule.getTableName(SharedMeta);
      expect(fromCore).toBe(fromRoot);
      expect(fromCore).toBe("shared_meta");
    });

    it("lifecycle decorators from core subpath register correctly", async () => {
      const { Table } = await import("../../core.js");
      const { Column } = await import("../../core.js");
      const { Id } = await import("../../core.js");
      const { PostLoad, getLifecycleCallbacks } = await import("../../core.js");

      @Table("lc_test")
      class LcTest {
        @Id @Column() id: number = 0;
        loaded: boolean = false;

        @PostLoad
        onLoad() {
          this.loaded = true;
        }
      }

      // Instantiate to trigger addInitializer
      new LcTest();

      const callbacks = getLifecycleCallbacks(LcTest);
      expect(callbacks.has("PostLoad")).toBe(true);
      expect(callbacks.get("PostLoad")?.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ──────────────────────────────────────────────
  // 5. Cross-subpath import of same symbol
  // ──────────────────────────────────────────────

  describe("importing same symbol from root and subpath", () => {
    it("Table from root and core subpath are the same function", async () => {
      const root = await import("../../index.js");
      const core = await import("../../core.js");
      expect(root.Table).toBe(core.Table);
    });

    it("Column from root and core subpath are the same function", async () => {
      const root = await import("../../index.js");
      const core = await import("../../core.js");
      expect(root.Column).toBe(core.Column);
    });

    it("ManyToOne from root and relations subpath are the same function", async () => {
      const root = await import("../../index.js");
      const rel = await import("../../relations.js");
      expect(root.ManyToOne).toBe(rel.ManyToOne);
    });

    it("TenantContext from root and tenant subpath are the same class", async () => {
      const root = await import("../../index.js");
      const tenant = await import("../../tenant-entry.js");
      expect(root.TenantContext).toBe(tenant.TenantContext);
    });

    it("PluginManager from root and plugins subpath are the same class", async () => {
      const root = await import("../../index.js");
      const plugins = await import("../../plugins-entry.js");
      expect(root.PluginManager).toBe(plugins.PluginManager);
    });
  });

  // ──────────────────────────────────────────────
  // 6. dist file structure validation
  // ──────────────────────────────────────────────

  describe("dist file structure", () => {
    it("dist directory exists", () => {
      expect(fs.existsSync(DIST_DIR)).toBe(true);
    });

    it("all entry point JS files exist", () => {
      const entries = [
        "index.js", "index.cjs",
        "core.js", "core.cjs",
        "relations.js", "relations.cjs",
        "tenant-entry.js", "tenant-entry.cjs",
        "observability-entry.js", "observability-entry.cjs",
        "graphql-entry.js", "graphql-entry.cjs",
        "rest-entry.js", "rest-entry.cjs",
        "plugins-entry.js", "plugins-entry.cjs",
      ];

      for (const entry of entries) {
        expect(
          fs.existsSync(path.join(DIST_DIR, entry)),
          `Missing dist file: ${entry}`,
        ).toBe(true);
      }
    });

    it("all entry point .d.ts files exist", () => {
      const entries = [
        "index.d.ts", "index.d.cts",
        "core.d.ts", "core.d.cts",
        "relations.d.ts", "relations.d.cts",
        "tenant-entry.d.ts", "tenant-entry.d.cts",
        "observability-entry.d.ts", "observability-entry.d.cts",
        "graphql-entry.d.ts", "graphql-entry.d.cts",
        "rest-entry.d.ts", "rest-entry.d.cts",
        "plugins-entry.d.ts", "plugins-entry.d.cts",
      ];

      for (const entry of entries) {
        expect(
          fs.existsSync(path.join(DIST_DIR, entry)),
          `Missing type file: ${entry}`,
        ).toBe(true);
      }
    });

    it("code splitting produced chunk files (modules are split, not monolithic)", () => {
      const files = fs.readdirSync(DIST_DIR);
      const chunks = files.filter((f) => f.startsWith("chunk-"));
      // With splitting: true, tsup should produce shared chunks
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("entry point files are not excessively large (splitting is working)", () => {
      // If splitting works, entry files re-export from chunks and should be small
      const entryFiles = ["core.js", "relations.js", "tenant-entry.js"];
      for (const entry of entryFiles) {
        const fullPath = path.join(DIST_DIR, entry);
        const stat = fs.statSync(fullPath);
        // Entry files with splitting should be small (mostly re-exports)
        // If they're over 500KB, splitting may not be working
        expect(
          stat.size,
          `${entry} is unexpectedly large (${stat.size} bytes) — splitting may not be working`,
        ).toBeLessThan(500 * 1024);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 7. tsup config validation
  // ──────────────────────────────────────────────

  describe("tsup configuration", () => {
    it("tsup.config.ts has all entry points", () => {
      const tsupPath = path.join(PKG_ROOT, "tsup.config.ts");
      const content = fs.readFileSync(tsupPath, "utf8");

      const expectedEntries = [
        "src/index.ts",
        "src/core.ts",
        "src/relations.ts",
        "src/tenant-entry.ts",
        "src/observability-entry.ts",
        "src/graphql-entry.ts",
        "src/rest-entry.ts",
        "src/plugins-entry.ts",
      ];

      for (const entry of expectedEntries) {
        expect(
          content.includes(entry),
          `tsup config missing entry: ${entry}`,
        ).toBe(true);
      }
    });

    it("splitting is enabled", () => {
      const tsupPath = path.join(PKG_ROOT, "tsup.config.ts");
      const content = fs.readFileSync(tsupPath, "utf8");
      expect(content).toContain("splitting: true");
    });

    it("both cjs and esm formats are configured", () => {
      const tsupPath = path.join(PKG_ROOT, "tsup.config.ts");
      const content = fs.readFileSync(tsupPath, "utf8");
      expect(content).toMatch(/format.*cjs/);
      expect(content).toMatch(/format.*esm/);
    });

    it("dts is enabled", () => {
      const tsupPath = path.join(PKG_ROOT, "tsup.config.ts");
      const content = fs.readFileSync(tsupPath, "utf8");
      expect(content).toContain("dts: true");
    });
  });

  // ──────────────────────────────────────────────
  // 8. Adversarial: no leaking internal paths
  // ──────────────────────────────────────────────

  describe("no internal paths leak", () => {
    it("there are no exports for internal modules like ./decorators or ./repository", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      const pkg = JSON.parse(raw);
      const exportKeys = Object.keys(pkg.exports);
      const internalPaths = exportKeys.filter(
        (k) => k.includes("/decorators") || k.includes("/repository") ||
               k.includes("/mapping") || k.includes("/query") ||
               k.includes("/cache") || k.includes("/schema") ||
               k.includes("/migration") || k.includes("/events"),
      );
      expect(internalPaths).toHaveLength(0);
    });

    it("no .internal or .private subpath exports exist", () => {
      const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
      const pkg = JSON.parse(raw);
      const exportKeys = Object.keys(pkg.exports);
      const badPaths = exportKeys.filter(
        (k) => k.includes("internal") || k.includes("private") || k.includes("__"),
      );
      expect(badPaths).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────
  // 9. All packages have sideEffects: false
  // ──────────────────────────────────────────────

  describe("all workspace packages have sideEffects: false", () => {
    it("every package in packages/ has sideEffects: false", () => {
      const packagesDir = path.resolve(PKG_ROOT, "..");
      const packageDirs = fs.readdirSync(packagesDir).filter((d) => {
        const pkgJsonPath = path.join(packagesDir, d, "package.json");
        return fs.existsSync(pkgJsonPath);
      });

      for (const dir of packageDirs) {
        const pkgJsonPath = path.join(packagesDir, dir, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        expect(
          pkg.sideEffects,
          `Package ${pkg.name} (packages/${dir}) is missing sideEffects: false`,
        ).toBe(false);
      }
    });
  });
});
