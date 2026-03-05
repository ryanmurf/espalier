import type { SchemaModel } from "./schema-model.js";

export interface SchemaExtractorOptions {
  entities: (new (...args: any[]) => any)[];
}

export function extractSchema(_options: SchemaExtractorOptions): SchemaModel {
  return { tables: [], relations: [] };
}
