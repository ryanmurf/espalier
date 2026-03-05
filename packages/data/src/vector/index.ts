export {
  Vector,
  getVectorFields,
  getVectorFieldMetadata,
} from "../decorators/vector.js";

export type {
  VectorOptions,
  VectorMetadataEntry,
} from "../decorators/vector.js";

export { VectorIndexManager } from "./vector-index-manager.js";

export type {
  VectorIndexOptions,
  VectorMetric,
} from "./vector-index-manager.js";

export type { EmbeddingProvider, EmbeddingHookOptions } from "./embedding-hook.js";
export { createEmbeddingHook, registerEmbeddingHook } from "./embedding-hook.js";

export type { NearestToResult } from "./vector-specifications.js";
export { similarTo, nearestTo } from "./vector-specifications.js";
