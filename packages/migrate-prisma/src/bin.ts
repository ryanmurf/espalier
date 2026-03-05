#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parsePrismaSchema } from "./parser.js";
import { generateEntityFile, generateEnumFile, generateIndexFile } from "./generator.js";

function toSnakeCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function main(): void {
  const args = process.argv.slice(2);

  let schemaPath = "./prisma/schema.prisma";
  let outputDir = "./src/entities";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--schema" && args[i + 1]) {
      schemaPath = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: espalier-migrate-prisma [options]

Options:
  --schema <path>  Path to Prisma schema file (default: ./prisma/schema.prisma)
  --output <path>  Output directory for generated entities (default: ./src/entities)
  -h, --help       Show this help message`);
      process.exit(0);
    }
  }

  const resolvedSchema = resolve(schemaPath);
  const resolvedOutput = resolve(outputDir);

  if (!existsSync(resolvedSchema)) {
    console.error(`Error: Schema file not found: ${resolvedSchema}`);
    process.exit(1);
  }

  const source = readFileSync(resolvedSchema, "utf-8");
  const schema = parsePrismaSchema(source);

  if (schema.models.length === 0 && schema.enums.length === 0) {
    console.error("No models or enums found in schema.");
    process.exit(1);
  }

  mkdirSync(resolvedOutput, { recursive: true });

  let filesWritten = 0;

  for (const model of schema.models) {
    const content = generateEntityFile(model, schema);
    const fileName = `${toSnakeCase(model.name)}.ts`;
    writeFileSync(join(resolvedOutput, fileName), content + "\n");
    console.log(`  Generated ${fileName}`);
    filesWritten++;
  }

  for (const prismaEnum of schema.enums) {
    const content = generateEnumFile(prismaEnum);
    const fileName = `${toSnakeCase(prismaEnum.name)}.ts`;
    writeFileSync(join(resolvedOutput, fileName), content + "\n");
    console.log(`  Generated ${fileName}`);
    filesWritten++;
  }

  const indexContent = generateIndexFile(schema.models, schema.enums);
  writeFileSync(join(resolvedOutput, "index.ts"), indexContent + "\n");
  console.log(`  Generated index.ts`);
  filesWritten++;

  console.log(`\nDone! ${filesWritten} files written to ${resolvedOutput}`);
}

main();
