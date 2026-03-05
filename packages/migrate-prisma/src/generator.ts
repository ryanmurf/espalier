/**
 * Generates Espalier entity TypeScript files from parsed Prisma schema.
 */

import type { PrismaSchema, PrismaModel, PrismaField, PrismaEnum, PrismaAttribute } from "./parser.js";

const PRISMA_TO_TS_TYPE: Record<string, string> = {
  String: "string",
  Int: "number",
  Float: "number",
  Decimal: "number",
  BigInt: "bigint",
  Boolean: "boolean",
  DateTime: "Date",
  Json: "Record<string, unknown>",
  Bytes: "Uint8Array",
};

function hasAttr(field: PrismaField, name: string): boolean {
  return field.attributes.some((a) => a.name === name);
}

function getAttr(field: PrismaField, name: string): PrismaAttribute | undefined {
  return field.attributes.find((a) => a.name === name);
}

function getModelAttr(model: PrismaModel, name: string): PrismaAttribute | undefined {
  return model.attributes.find((a) => a.name === name);
}

function toSnakeCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function getTableName(model: PrismaModel): string {
  const mapAttr = getModelAttr(model, "map");
  if (mapAttr && mapAttr.args.length > 0) {
    return mapAttr.args[0].replace(/"/g, "");
  }
  return toSnakeCase(model.name) + "s";
}

function getColumnName(field: PrismaField): string | undefined {
  const mapAttr = getAttr(field, "map");
  if (mapAttr && mapAttr.args.length > 0) {
    return mapAttr.args[0].replace(/"/g, "");
  }
  return undefined;
}

function getDefaultValue(field: PrismaField): string | undefined {
  const defaultAttr = getAttr(field, "default");
  if (!defaultAttr || defaultAttr.args.length === 0) return undefined;

  const raw = defaultAttr.args[0];
  if (raw === "autoincrement()") return undefined; // handled by generated: true
  if (raw === "now()") return undefined; // handled by @CreatedDate
  if (raw === "uuid()") return undefined; // could map to a generator
  if (raw === "cuid()") return undefined;
  if (raw === "true" || raw === "false") return raw;
  return raw;
}

function isGenerated(field: PrismaField): boolean {
  const defaultAttr = getAttr(field, "default");
  if (!defaultAttr) return false;
  return defaultAttr.args.some((a) => a.includes("autoincrement"));
}

function isCreatedDate(field: PrismaField): boolean {
  const defaultAttr = getAttr(field, "default");
  if (!defaultAttr) return false;
  return defaultAttr.args.some((a) => a.includes("now()"));
}

function isUpdatedAt(field: PrismaField): boolean {
  return hasAttr(field, "updatedAt");
}

interface RelationInfo {
  type: "ManyToOne" | "OneToMany" | "OneToOne" | "ManyToMany";
  target: string;
  foreignKey?: string;
  mappedBy?: string;
}

function detectRelation(
  field: PrismaField,
  model: PrismaModel,
  allModels: PrismaModel[],
): RelationInfo | undefined {
  // Is this field a model reference?
  const isModelType = allModels.some((m) => m.name === field.type);
  if (!isModelType) return undefined;

  const relationAttr = getAttr(field, "relation");

  if (field.isList) {
    // List of model → check if the other side has a list too (ManyToMany) or not (OneToMany)
    const otherModel = allModels.find((m) => m.name === field.type);
    const reverseField = otherModel?.fields.find(
      (f) => f.type === model.name && f.isList,
    );

    if (reverseField) {
      return { type: "ManyToMany", target: field.type };
    }

    return {
      type: "OneToMany",
      target: field.type,
      mappedBy: findMappedByField(field.type, model.name, allModels),
    };
  }

  // Single model reference
  if (relationAttr) {
    // Extract fields and references from @relation
    const fieldsMatch = relationAttr.args.join(",").match(/fields:\s*\[([^\]]+)\]/);
    const foreignKey = fieldsMatch
      ? fieldsMatch[1].trim().split(",")[0].trim()
      : undefined;

    // Check if the other side has a list (this is ManyToOne) or single (OneToOne)
    const otherModel = allModels.find((m) => m.name === field.type);
    const reverseField = otherModel?.fields.find(
      (f) => f.type === model.name,
    );

    if (reverseField?.isList) {
      return { type: "ManyToOne", target: field.type, foreignKey };
    }

    return { type: "OneToOne", target: field.type, foreignKey };
  }

  // No @relation attr but type is a model — infer ManyToOne
  return { type: "ManyToOne", target: field.type };
}

function findMappedByField(
  otherModelName: string,
  thisModelName: string,
  allModels: PrismaModel[],
): string | undefined {
  const otherModel = allModels.find((m) => m.name === otherModelName);
  if (!otherModel) return undefined;

  const reverseField = otherModel.fields.find(
    (f) => f.type === thisModelName && !f.isList,
  );
  return reverseField?.name;
}

function isForeignKeyField(
  field: PrismaField,
  model: PrismaModel,
  allModels: PrismaModel[],
): boolean {
  // A field is a FK if another field in the same model has @relation(fields: [thisField])
  for (const other of model.fields) {
    const rel = getAttr(other, "relation");
    if (!rel) continue;
    const fieldsMatch = rel.args.join(",").match(/fields:\s*\[([^\]]+)\]/);
    if (fieldsMatch) {
      const fkFields = fieldsMatch[1].split(",").map((s) => s.trim());
      if (fkFields.includes(field.name)) return true;
    }
  }
  return false;
}

export function generateEntityFile(
  model: PrismaModel,
  schema: PrismaSchema,
): string {
  const lines: string[] = [];
  const imports = new Set<string>();
  const relationImports = new Set<string>();
  const auditingImports = new Set<string>();

  // Always need Table, Column, Id
  imports.add("Table");
  imports.add("Column");

  const tableName = getTableName(model);
  const needsId = model.fields.some((f) => hasAttr(f, "id"));
  if (needsId) imports.add("Id");

  // Pre-scan for needed decorators
  for (const field of model.fields) {
    const relation = detectRelation(field, model, schema.models);
    if (relation) {
      relationImports.add(relation.type);
    }
    if (hasAttr(field, "unique")) {
      // handled via Column options
    }
    if (isCreatedDate(field)) {
      auditingImports.add("CreatedDate");
    }
    if (isUpdatedAt(field)) {
      auditingImports.add("LastModifiedDate");
    }
  }

  // Import statements
  const coreImports = [...imports].sort();
  if (auditingImports.size > 0) {
    coreImports.push(...[...auditingImports].sort());
  }
  lines.push(`import { ${coreImports.join(", ")} } from "espalier-data/core";`);

  if (relationImports.size > 0) {
    lines.push(`import { ${[...relationImports].sort().join(", ")} } from "espalier-data/relations";`);
  }

  // Import related entity types
  const relatedTypes = new Set<string>();
  for (const field of model.fields) {
    const relation = detectRelation(field, model, schema.models);
    if (relation && relation.target !== model.name) {
      relatedTypes.add(relation.target);
    }
  }
  for (const relType of [...relatedTypes].sort()) {
    lines.push(`import type { ${relType} } from "./${toSnakeCase(relType)}.js";`);
  }

  lines.push("");

  // Class declaration
  lines.push(`@Table("${tableName}")`);
  lines.push(`export class ${model.name} {`);

  for (const field of model.fields) {
    const relation = detectRelation(field, model, schema.models);

    // Skip FK fields (they're handled by the relation decorator)
    if (isForeignKeyField(field, model, schema.models)) continue;

    // Skip relation fields — handle them with relation decorators
    if (relation) {
      const decoratorLines = generateRelationField(field, relation);
      for (const dl of decoratorLines) {
        lines.push(`  ${dl}`);
      }
      lines.push("");
      continue;
    }

    // Regular field
    const decorators = generateFieldDecorators(field);
    for (const dec of decorators) {
      lines.push(`  ${dec}`);
    }

    const tsType = resolveType(field, schema);
    const defaultVal = getFieldDefault(field, tsType);
    const optional = field.isOptional ? "?" : "";

    lines.push(`  accessor ${field.name}${optional} = ${defaultVal};`);
    lines.push("");
  }

  lines.push("}");

  return lines.join("\n");
}

function generateFieldDecorators(field: PrismaField): string[] {
  const decs: string[] = [];

  if (hasAttr(field, "id")) {
    decs.push("@Id()");
  }

  if (isCreatedDate(field)) {
    decs.push("@CreatedDate()");
  } else if (isUpdatedAt(field)) {
    decs.push("@LastModifiedDate()");
  }

  const columnOpts: string[] = [];
  const colName = getColumnName(field);
  if (colName) columnOpts.push(`name: "${colName}"`);
  if (hasAttr(field, "unique")) columnOpts.push("unique: true");
  if (isGenerated(field)) columnOpts.push("generated: true");

  const defaultVal = getDefaultValue(field);
  if (defaultVal && !isCreatedDate(field) && !isUpdatedAt(field)) {
    columnOpts.push(`default: ${defaultVal}`);
  }

  if (columnOpts.length > 0) {
    decs.push(`@Column({ ${columnOpts.join(", ")} })`);
  } else {
    decs.push("@Column()");
  }

  return decs;
}

function generateRelationField(
  field: PrismaField,
  relation: RelationInfo,
): string[] {
  const decs: string[] = [];

  switch (relation.type) {
    case "ManyToOne":
      if (relation.foreignKey) {
        decs.push(`@ManyToOne(() => ${relation.target}, { joinColumn: "${relation.foreignKey}" })`);
      } else {
        decs.push(`@ManyToOne(() => ${relation.target})`);
      }
      decs.push(`accessor ${field.name}!: ${relation.target};`);
      break;

    case "OneToMany":
      if (relation.mappedBy) {
        decs.push(`@OneToMany(() => ${relation.target}, { mappedBy: "${relation.mappedBy}" })`);
      } else {
        decs.push(`@OneToMany(() => ${relation.target})`);
      }
      decs.push(`accessor ${field.name}: ${relation.target}[] = [];`);
      break;

    case "OneToOne":
      if (relation.foreignKey) {
        decs.push(`@OneToOne(() => ${relation.target}, { joinColumn: "${relation.foreignKey}" })`);
      } else {
        decs.push(`@OneToOne(() => ${relation.target})`);
      }
      decs.push(`accessor ${field.name}!: ${relation.target};`);
      break;

    case "ManyToMany":
      decs.push(`@ManyToMany(() => ${relation.target})`);
      decs.push(`accessor ${field.name}: ${relation.target}[] = [];`);
      break;
  }

  return decs;
}

function resolveType(field: PrismaField, schema: PrismaSchema): string {
  const mapped = PRISMA_TO_TS_TYPE[field.type];
  if (mapped) return mapped;

  // Check if it's an enum
  const isEnum = schema.enums.some((e) => e.name === field.type);
  if (isEnum) return field.type;

  // Must be a model reference — handled by relation
  return field.type;
}

function getFieldDefault(field: PrismaField, tsType: string): string {
  if (field.isOptional) return "undefined as any";

  switch (tsType) {
    case "string": return '""';
    case "number": return "0";
    case "bigint": return "0n";
    case "boolean": return "false";
    case "Date": return "new Date()";
    case "Uint8Array": return "new Uint8Array()";
    case "Record<string, unknown>": return "{}";
    default: return "undefined as any";
  }
}

export function generateEnumFile(prismaEnum: PrismaEnum): string {
  const lines: string[] = [];
  lines.push(`export enum ${prismaEnum.name} {`);
  for (const value of prismaEnum.values) {
    lines.push(`  ${value} = "${value}",`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function generateIndexFile(
  models: PrismaModel[],
  enums: PrismaEnum[],
): string {
  const lines: string[] = [];

  for (const e of enums) {
    lines.push(`export { ${e.name} } from "./${toSnakeCase(e.name)}.js";`);
  }

  for (const m of models) {
    lines.push(`export { ${m.name} } from "./${toSnakeCase(m.name)}.js";`);
  }

  return lines.join("\n");
}
