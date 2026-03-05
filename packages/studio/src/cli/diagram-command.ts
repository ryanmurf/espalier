import type { DiagramFormat } from "../diagram/diagram-generator.js";

export interface DiagramCommandOptions {
  format?: DiagramFormat;
  output?: string;
  config?: string;
}

export function runDiagramCommand(_options: DiagramCommandOptions): void {
  // Placeholder — will generate diagram to stdout or file
}
