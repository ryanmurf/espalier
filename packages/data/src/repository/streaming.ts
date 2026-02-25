import type { Specification } from "../query/specification.js";

export interface StreamOptions<T = unknown> {
  cursorSize?: number;
  where?: Specification<T>;
}
