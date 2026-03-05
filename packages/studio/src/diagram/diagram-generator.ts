import type { SchemaModel } from "../schema/schema-model.js";

export type DiagramFormat = "mermaid" | "d2" | "plantuml";

export interface DiagramOptions {
  format: DiagramFormat;
  title?: string;
}

export function generateDiagram(_schema: SchemaModel, _options: DiagramOptions): string {
  return "";
}
