#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { generateEntityFile, generateEnumFile, generateIndexFile } from "./generator.js";
import { parsePrismaSchema } from "./parser.js";

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

  const cwd = process.cwd();
  const resolvedSchema = resolve(schemaPath);
  const resolvedOutput = resolve(outputDir);

  // Validate output path is within or relative to CWD (prevent path traversal)
  const rel = relative(cwd, resolvedOutput);
  if (rel.startsWith("..") || (resolve(rel) !== resolvedOutput && rel.startsWith("/"))) {
    console.error(`Error: Output path must be within the current working directory. Got: ${resolvedOutput}`);
    process.exit(1);
  }

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
    try {
      const content = generateEntityFile(model, schema);
      const fileName = `${toSnakeCase(model.name)}.ts`;
      writeFileSync(join(resolvedOutput, fileName), content + "\n");
      console.log(`  Generated ${fileName}`);
      filesWritten++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error generating entity for model "${model.name}": ${message}`);
      process.exit(1);
    }
  }

  for (const prismaEnum of schema.enums) {
    try {
      const content = generateEnumFile(prismaEnum);
      const fileName = `${toSnakeCase(prismaEnum.name)}.ts`;
      writeFileSync(join(resolvedOutput, fileName), content + "\n");
      console.log(`  Generated ${fileName}`);
      filesWritten++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error generating enum "${prismaEnum.name}": ${message}`);
      process.exit(1);
    }
  }

  const indexContent = generateIndexFile(schema.models, schema.enums);
  writeFileSync(join(resolvedOutput, "index.ts"), indexContent + "\n");
  console.log(`  Generated index.ts`);
  filesWritten++;

  console.log(`\nDone! ${filesWritten} files written to ${resolvedOutput}`);
}

main();
