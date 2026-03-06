export type {
  VectorMetadataEntry,
  VectorOptions,
} from "../decorators/vector.js";
export {
  getVectorFieldMetadata,
  getVectorFields,
  Vector,
} from "../decorators/vector.js";
export type { EmbeddingHookOptions, EmbeddingProvider } from "./embedding-hook.js";
export { createEmbeddingHook, registerEmbeddingHook } from "./embedding-hook.js";
export type {
  VectorIndexOptions,
  VectorMetric,
} from "./vector-index-manager.js";
export { VectorIndexManager } from "./vector-index-manager.js";

export type { NearestToResult } from "./vector-specifications.js";
export { nearestTo, similarTo } from "./vector-specifications.js";

export { toVectorLiteral } from "./vector-utils.js";
