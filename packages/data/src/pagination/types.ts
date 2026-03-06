import type { SelectBuilder } from "../query/query-builder.js";
import type { Page } from "../repository/paging.js";

/**
 * Base pagination strategy interface.
 *
 * TRequest: the request type (e.g., Pageable, CursorPageable, KeysetPageable)
 * TResult: the result type (e.g., Page<T>, CursorPage<T>, KeysetPage<T>)
 */
export interface PaginationStrategy<TRequest = unknown, TResult = unknown> {
  /** Strategy identifier (e.g., "offset", "cursor", "keyset"). */
  readonly name: string;

  /**
   * Apply pagination clauses (LIMIT, OFFSET, WHERE for cursor/keyset) to a query builder.
   */
  applyToQuery(builder: SelectBuilder, request: TRequest): void;

  /**
   * Build the paginated result from raw rows and metadata.
   */
  buildResult<T>(rows: T[], request: TRequest, totalCount: number): TResult;
}

// ---------------------------------------------------------------------------
// Cursor (Relay) pagination types
// ---------------------------------------------------------------------------

/**
 * Request for Relay-style cursor pagination.
 */
export interface CursorPageable {
  /** Number of items to fetch. */
  first?: number;
  /** Cursor to fetch items after. */
  after?: string;
  /** Number of items to fetch from the end. */
  last?: number;
  /** Cursor to fetch items before. */
  before?: string;
}

/**
 * A single edge in a Relay-style cursor connection.
 */
export interface Edge<T> {
  node: T;
  cursor: string;
}

/**
 * Page info for Relay-style cursor connections.
 */
export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/**
 * Relay-style cursor connection result.
 */
export interface CursorPage<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Keyset (seek) pagination types
// ---------------------------------------------------------------------------

/**
 * Request for keyset (seek) pagination.
 */
export interface KeysetPageable {
  /** Number of items to fetch. */
  size: number;
  /** Sort column for keyset ordering. */
  sortColumn: string;
  /** Sort direction. */
  sortDirection: "ASC" | "DESC";
  /** Value of the sort column from the last item of the previous page. */
  afterValue?: unknown;
  /** ID of the last item for tie-breaking. */
  afterId?: unknown;
}

/**
 * Keyset pagination result.
 */
export interface KeysetPage<T> {
  content: T[];
  size: number;
  hasNext: boolean;
  /** The sort column value of the last returned item (for next page). */
  lastValue: unknown | null;
  /** The ID of the last returned item (for tie-breaking). */
  lastId: unknown | null;
}

// ---------------------------------------------------------------------------
// Union type for all paginated results
// ---------------------------------------------------------------------------

/**
 * Union of all paginated result types.
 */
export type PaginatedResult<T> = Page<T> | CursorPage<T> | KeysetPage<T>;
