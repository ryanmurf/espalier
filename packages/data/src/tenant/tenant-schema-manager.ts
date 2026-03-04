import type { Connection, DataSource } from "espalier-jdbc";
import { validateIdentifier, quoteIdentifier } from "espalier-jdbc";
import { DdlGenerator } from "../schema/ddl-generator.js";

/**
 * Manages PostgreSQL schemas for multi-tenant deployments.
 * Provides utilities for creating, dropping, and provisioning
 * per-tenant schemas with entity tables.
 */
export class TenantSchemaManager {
  private readonly ddl = new DdlGenerator();

  /**
   * Creates a PostgreSQL schema if it does not exist.
   */
  async createTenantSchema(connection: Connection, schemaName: string): Promise<void> {
    validateIdentifier(schemaName, "schema");
    const stmt = connection.createStatement();
    try {
      await stmt.executeUpdate(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
    } finally {
      await stmt.close();
    }
  }

  /**
   * Drops a PostgreSQL schema.
   */
  async dropTenantSchema(connection: Connection, schemaName: string, cascade = false): Promise<void> {
    validateIdentifier(schemaName, "schema");
    const cascadeClause = cascade ? " CASCADE" : "";
    const stmt = connection.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)}${cascadeClause}`);
    } finally {
      await stmt.close();
    }
  }

  /**
   * Provisions a new tenant: creates the schema and all entity tables within it.
   * Idempotent — uses IF NOT EXISTS for both schema and tables.
   */
  async provisionTenant(
    dataSource: DataSource,
    tenantId: string,
    entities: (new (...args: any[]) => any)[],
    schemaResolver?: (tenantId: string) => string,
  ): Promise<void> {
    const schemaName = schemaResolver ? schemaResolver(tenantId) : tenantId;
    validateIdentifier(schemaName, "schema");

    const conn = await dataSource.getConnection();
    try {
      await this.createTenantSchema(conn, schemaName);

      for (const entity of entities) {
        const createSql = this.ddl.generateCreateTable(entity, {
          ifNotExists: true,
          schema: schemaName,
        });
        const stmt = conn.createStatement();
        try {
          await stmt.executeUpdate(createSql);
        } finally {
          await stmt.close();
        }

        // Create tenant index if entity uses @TenantId
        const indexSql = this.ddl.generateTenantIndex(entity, {
          ifNotExists: true,
          schema: schemaName,
        });
        if (indexSql) {
          const idxStmt = conn.createStatement();
          try {
            await idxStmt.executeUpdate(indexSql);
          } finally {
            await idxStmt.close();
          }
        }
      }

      // Generate join tables for many-to-many relations
      const joinTableSqls = this.ddl.generateJoinTables(entities, { ifNotExists: true });
      for (const sql of joinTableSqls) {
        const stmt = conn.createStatement();
        try {
          await stmt.executeUpdate(sql);
        } finally {
          await stmt.close();
        }
      }
    } finally {
      await conn.close();
    }
  }

  /**
   * Deprovisions a tenant by dropping the entire schema with CASCADE.
   */
  async deprovisionTenant(
    dataSource: DataSource,
    tenantId: string,
    schemaResolver?: (tenantId: string) => string,
  ): Promise<void> {
    const schemaName = schemaResolver ? schemaResolver(tenantId) : tenantId;
    validateIdentifier(schemaName, "schema");

    const conn = await dataSource.getConnection();
    try {
      await this.dropTenantSchema(conn, schemaName, true);
    } finally {
      await conn.close();
    }
  }

  /**
   * Lists PostgreSQL schemas matching an optional prefix.
   * Excludes system schemas (pg_*, information_schema).
   */
  async listTenantSchemas(connection: Connection, prefix?: string): Promise<string[]> {
    let sql = `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' AND schema_name != 'public'`;
    const params: string[] = [];
    if (prefix) {
      validateIdentifier(prefix, "schema prefix");
      // Escape LIKE wildcard characters (%, _) in the prefix value
      const escapedPrefix = prefix.replace(/[%_\\]/g, "\\$&");
      sql += ` AND schema_name LIKE $1 ESCAPE '\\'`;
      params.push(`${escapedPrefix}%`);
    }
    sql += ` ORDER BY schema_name`;

    const stmt = connection.prepareStatement(sql);
    try {
      for (let i = 0; i < params.length; i++) {
        stmt.setParameter(i + 1, params[i]);
      }
      const rs = await stmt.executeQuery();
      const schemas: string[] = [];
      while (await rs.next()) {
        const row = rs.getRow();
        const name = Object.values(row)[0];
        if (typeof name === "string") {
          schemas.push(name);
        }
      }
      return schemas;
    } finally {
      await stmt.close();
    }
  }
}
