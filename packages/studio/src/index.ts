export type {
  SchemaColumn,
  SchemaRelation,
  SchemaTable,
  SchemaModel,
  RelationType,
  SchemaExtractorOptions,
} from "./schema/index.js";
export { extractSchema } from "./schema/index.js";

export type { DiagramFormat, DiagramOptions } from "./diagram/index.js";
export { generateDiagram } from "./diagram/index.js";

export type { StudioServerOptions, StudioServer } from "./server/index.js";
export { createStudioServer } from "./server/index.js";

export { startStudio } from "./cli/studio-command.js";
export type { StudioCommandOptions } from "./cli/studio-command.js";
export { runDiagramCommand } from "./cli/diagram-command.js";
export type { DiagramCommandOptions } from "./cli/diagram-command.js";
