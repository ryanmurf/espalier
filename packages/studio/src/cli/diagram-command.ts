import { writeFileSync } from "node:fs";
import type { DiagramFormat } from "../diagram/diagram-generator.js";
import { generateDiagram } from "../diagram/index.js";
import { extractSchema } from "../schema/index.js";

export interface DiagramCommandOptions {
  format?: DiagramFormat;
  output?: string;
  entities: (new (...args: any[]) => any)[];
  title?: string;
}

export function runDiagramCommand(options: DiagramCommandOptions): void {
  const format = options.format ?? "mermaid";
  const schema = extractSchema({ entities: options.entities });
  const diagram = generateDiagram(schema, { format, title: options.title });

  if (options.output) {
    writeFileSync(options.output, diagram, "utf-8");
    process.stdout.write(`Diagram written to ${options.output}\n`);
  } else {
    process.stdout.write(diagram);
  }
}
