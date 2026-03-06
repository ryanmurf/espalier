import type { SchemaModel, SchemaRelation } from "../schema/schema-model.js";

export type DiagramFormat = "mermaid" | "d2" | "plantuml";

export interface DiagramOptions {
  format: DiagramFormat;
  title?: string;
}

export function generateDiagram(schema: SchemaModel, options: DiagramOptions): string {
  switch (options.format) {
    case "mermaid":
      return generateMermaid(schema, options.title);
    case "d2":
      return generateD2(schema, options.title);
    case "plantuml":
      return generatePlantUML(schema, options.title);
  }
}

function mermaidColumnType(col: { type?: string; isPrimaryKey: boolean }): string {
  if (col.type) return col.type.replace(/\s+/g, "_");
  if (col.isPrimaryKey) return "PK";
  return "string";
}

function mermaidColumnAnnotation(col: {
  isPrimaryKey: boolean;
  isVersion: boolean;
  isCreatedDate: boolean;
  isLastModifiedDate: boolean;
  isTenantId: boolean;
  unique?: boolean;
}): string {
  const parts: string[] = [];
  if (col.isPrimaryKey) parts.push("PK");
  if (col.unique) parts.push("UK");
  if (col.isVersion) parts.push("VER");
  if (col.isTenantId) parts.push("TID");
  return parts.length > 0 ? ` "${parts.join(",")}"` : "";
}

function generateMermaid(schema: SchemaModel, title?: string): string {
  const lines: string[] = [];

  if (title) {
    lines.push("---");
    lines.push(`title: ${title}`);
    lines.push("---");
  }

  lines.push("erDiagram");

  for (const table of schema.tables) {
    lines.push(`    ${table.tableName} {`);
    for (const col of table.columns) {
      const type = mermaidColumnType(col);
      const annotation = mermaidColumnAnnotation(col);
      lines.push(`        ${type} ${col.columnName}${annotation}`);
    }
    lines.push("    }");
  }

  const rendered = new Set<string>();
  for (const rel of schema.relations) {
    const key = relationKey(rel);
    if (rendered.has(key)) continue;
    rendered.add(key);

    const connector = mermaidConnector(rel);
    const label = rel.fieldName;
    lines.push(`    ${rel.sourceTable} ${connector} ${rel.targetTable} : "${label}"`);
  }

  return lines.join("\n") + "\n";
}

function mermaidConnector(rel: SchemaRelation): string {
  switch (rel.type) {
    case "ManyToOne":
      return rel.nullable ? "}o--||" : "}|--||";
    case "OneToMany":
      return "||--o{";
    case "ManyToMany":
      return "}o--o{";
    case "OneToOne":
      return rel.nullable ? "|o--||" : "||--||";
  }
}

function relationKey(rel: SchemaRelation): string {
  const tables = [rel.sourceTable, rel.targetTable].sort();
  return `${tables[0]}:${tables[1]}:${rel.fieldName}`;
}

function generateD2(schema: SchemaModel, title?: string): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`title: ${title}`);
    lines.push("");
  }

  for (const table of schema.tables) {
    lines.push(`${table.tableName}: {`);
    lines.push("    shape: sql_table");
    for (const col of table.columns) {
      const constraint = d2Constraint(col);
      lines.push(`    ${col.columnName}: ${col.type ?? "string"}${constraint}`);
    }
    lines.push("}");
    lines.push("");
  }

  const rendered = new Set<string>();
  for (const rel of schema.relations) {
    const key = relationKey(rel);
    if (rendered.has(key)) continue;
    rendered.add(key);

    const label = d2Label(rel);
    lines.push(`${rel.sourceTable} -> ${rel.targetTable}: ${label}`);
  }

  return lines.join("\n") + "\n";
}

function d2Constraint(col: { isPrimaryKey: boolean; unique?: boolean }): string {
  if (col.isPrimaryKey) return " {constraint: primary_key}";
  if (col.unique) return " {constraint: unique}";
  return "";
}

function d2Label(rel: SchemaRelation): string {
  switch (rel.type) {
    case "ManyToOne":
      return `${rel.fieldName} (N:1)`;
    case "OneToMany":
      return `${rel.fieldName} (1:N)`;
    case "ManyToMany":
      return `${rel.fieldName} (N:M)`;
    case "OneToOne":
      return `${rel.fieldName} (1:1)`;
  }
}

function generatePlantUML(schema: SchemaModel, title?: string): string {
  const lines: string[] = [];

  lines.push("@startuml");
  if (title) {
    lines.push(`title ${title}`);
  }
  lines.push("");

  for (const table of schema.tables) {
    lines.push(`entity "${table.tableName}" as ${sanitizeAlias(table.tableName)} {`);
    const pkCols = table.columns.filter((c) => c.isPrimaryKey);
    const otherCols = table.columns.filter((c) => !c.isPrimaryKey);

    for (const col of pkCols) {
      lines.push(`    * ${col.columnName} : ${col.type ?? "PK"} <<PK>>`);
    }

    if (pkCols.length > 0 && otherCols.length > 0) {
      lines.push("    --");
    }

    for (const col of otherCols) {
      const nullable = col.nullable ? "o " : "* ";
      const stereo = plantumlStereotype(col);
      lines.push(`    ${nullable}${col.columnName} : ${col.type ?? "string"}${stereo}`);
    }
    lines.push("}");
    lines.push("");
  }

  const rendered = new Set<string>();
  for (const rel of schema.relations) {
    const key = relationKey(rel);
    if (rendered.has(key)) continue;
    rendered.add(key);

    const src = sanitizeAlias(rel.sourceTable);
    const tgt = sanitizeAlias(rel.targetTable);
    const connector = plantumlConnector(rel);
    lines.push(`${src} ${connector} ${tgt} : ${rel.fieldName}`);
  }

  lines.push("");
  lines.push("@enduml");

  return lines.join("\n") + "\n";
}

function sanitizeAlias(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function plantumlStereotype(col: {
  isVersion: boolean;
  isCreatedDate: boolean;
  isLastModifiedDate: boolean;
  isTenantId: boolean;
  unique?: boolean;
}): string {
  if (col.unique) return " <<UK>>";
  if (col.isVersion) return " <<VER>>";
  if (col.isTenantId) return " <<TID>>";
  return "";
}

function plantumlConnector(rel: SchemaRelation): string {
  switch (rel.type) {
    case "ManyToOne":
      return "}o--||";
    case "OneToMany":
      return "||--o{";
    case "ManyToMany":
      return "}o--o{";
    case "OneToOne":
      return rel.nullable ? "|o--||" : "||--||";
  }
}
