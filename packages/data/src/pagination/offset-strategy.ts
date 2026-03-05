import type { SelectBuilder } from "../query/query-builder.js";
import type { Page, Pageable } from "../repository/paging.js";
import { createPage } from "../repository/paging.js";
import type { PaginationStrategy } from "./types.js";

/**
 * Options for configuring the offset pagination strategy.
 */
export interface OffsetStrategyOptions {
  /** Maximum allowed page size. Default: 1000. */
  maxPageSize?: number;
}

/**
 * Offset-based pagination strategy (traditional LIMIT/OFFSET).
 *
 * This is the default strategy and is backward-compatible with existing
 * Pageable/Page types used throughout the codebase.
 */
export class OffsetPaginationStrategy implements PaginationStrategy<Pageable, Page<unknown>> {
  readonly name = "offset";

  private readonly maxPageSize: number;

  constructor(options?: OffsetStrategyOptions) {
    this.maxPageSize = options?.maxPageSize ?? 1000;
  }

  applyToQuery(builder: SelectBuilder, request: Pageable): void {
    if (request.sort) {
      for (const s of request.sort) {
        builder.orderBy(s.property, s.direction);
      }
    }

    const size = Math.min(request.size, this.maxPageSize);
    builder.limit(size);
    builder.offset(request.page * size);
  }

  buildResult<T>(rows: T[], request: Pageable, totalCount: number): Page<T> {
    return createPage(rows, request, totalCount);
  }
}
