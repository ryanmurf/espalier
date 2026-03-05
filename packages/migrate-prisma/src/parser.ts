/**
 * Minimal Prisma schema parser.
 * Parses models, enums, and their fields/attributes from .prisma files.
 */

export interface PrismaField {
  name: string;
  type: string;
  isOptional: boolean;
  isList: boolean;
  attributes: PrismaAttribute[];
}

export interface PrismaAttribute {
  name: string; // e.g. "@id", "@unique", "@default", "@relation", "@map"
  args: string[]; // raw argument strings
}

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
  attributes: PrismaAttribute[]; // model-level: @@map, @@unique, @@index
}

export interface PrismaEnum {
  name: string;
  values: string[];
}

export interface PrismaSchema {
  models: PrismaModel[];
  enums: PrismaEnum[];
}

function splitTopLevelArgs(raw: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args.filter((a) => a.length > 0);
}

function parseAttributes(line: string): PrismaAttribute[] {
  const attrs: PrismaAttribute[] = [];
  // Match @name or @@name, then extract balanced parentheses content
  const nameRegex = /@@?(\w+)/g;
  let nameMatch: RegExpExecArray | null;

  while ((nameMatch = nameRegex.exec(line)) !== null) {
    const name = nameMatch[1];
    const afterName = nameMatch.index + nameMatch[0].length;

    if (afterName < line.length && line[afterName] === "(") {
      // Extract balanced parentheses content
      let depth = 0;
      let start = afterName + 1;
      let end = start;
      for (let j = afterName; j < line.length; j++) {
        if (line[j] === "(") depth++;
        else if (line[j] === ")") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      const rawArgs = line.slice(start, end).trim();
      const args = rawArgs
        ? splitTopLevelArgs(rawArgs)
        : [];
      attrs.push({ name, args });
      nameRegex.lastIndex = end + 1;
    } else {
      attrs.push({ name, args: [] });
    }
  }

  return attrs;
}

function parseField(line: string): PrismaField | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) return null;

  // Field format: name Type? @attr1 @attr2(...)
  const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?\??(\[\])?\s*(.*)?$/);
  if (!fieldMatch) return null;

  const name = fieldMatch[1];
  let type = fieldMatch[2];
  const isList = !!(fieldMatch[3] || fieldMatch[4]);
  const isOptional = trimmed.includes("?");
  const attrPart = fieldMatch[5] || "";
  const attributes = parseAttributes(attrPart);

  return { name, type, isOptional, isList, attributes };
}

export function parsePrismaSchema(source: string): PrismaSchema {
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];

  const lines = source.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // model Name {
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      const model: PrismaModel = {
        name: modelMatch[1],
        fields: [],
        attributes: [],
      };

      i++;
      while (i < lines.length) {
        const fieldLine = lines[i].trim();
        if (fieldLine === "}") break;

        if (fieldLine.startsWith("@@")) {
          model.attributes.push(...parseAttributes(fieldLine));
        } else {
          const field = parseField(fieldLine);
          if (field) model.fields.push(field);
        }
        i++;
      }

      models.push(model);
      i++;
      continue;
    }

    // enum Name {
    const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
    if (enumMatch) {
      const prismaEnum: PrismaEnum = {
        name: enumMatch[1],
        values: [],
      };

      i++;
      while (i < lines.length) {
        const valueLine = lines[i].trim();
        if (valueLine === "}") break;
        if (valueLine && !valueLine.startsWith("//")) {
          prismaEnum.values.push(valueLine);
        }
        i++;
      }

      enums.push(prismaEnum);
      i++;
      continue;
    }

    i++;
  }

  return { models, enums };
}
