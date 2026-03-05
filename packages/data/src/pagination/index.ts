export type {
  PaginationStrategy,
  CursorPageable,
  Edge,
  PageInfo,
  CursorPage,
  KeysetPageable,
  KeysetPage,
  PaginatedResult,
} from "./types.js";

export { OffsetPaginationStrategy } from "./offset-strategy.js";

export {
  PaginationStrategyRegistry,
  getGlobalPaginationRegistry,
  setGlobalPaginationRegistry,
} from "./strategy-registry.js";
