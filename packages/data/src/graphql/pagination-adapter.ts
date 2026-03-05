/**
 * Adapter that bridges a PaginationStrategy to GraphQL SDL and resolver logic.
 */
export interface GraphQLPaginationAdapter {
  /** Strategy name (e.g., "offset", "cursor", "keyset"). */
  readonly name: string;

  /**
   * Generate shared SDL type definitions (e.g., PageInfo, Connection types).
   * Called once per schema generation.
   */
  generateSharedTypes(): string;

  /**
   * Generate entity-specific connection type SDL.
   */
  generateConnectionType(typeName: string): string;

  /**
   * Generate query arguments for the paginated list field.
   */
  generateQueryArgs(): string;

  /**
   * Convert GraphQL resolver args to the strategy's request type.
   */
  mapResolverArgs(args: Record<string, unknown>): unknown;

  /**
   * Convert the strategy's result to the GraphQL response shape.
   */
  mapResult(result: unknown): unknown;
}

/**
 * Offset pagination adapter (default, backward compatible).
 */
export class OffsetPaginationAdapter implements GraphQLPaginationAdapter {
  readonly name = "offset";

  generateSharedTypes(): string {
    return `type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  totalElements: Int!
  totalPages: Int!
  page: Int!
  size: Int!
}`;
  }

  generateConnectionType(typeName: string): string {
    return `type ${typeName}Connection {
  content: [${typeName}!]!
  pageInfo: PageInfo!
}`;
  }

  generateQueryArgs(): string {
    return "page: Int = 0, size: Int = 20, sort: String";
  }

  mapResolverArgs(args: Record<string, unknown>): {
    page: number;
    size: number;
    sort?: string;
  } {
    return {
      page: (args.page as number) ?? 0,
      size: (args.size as number) ?? 20,
      sort: args.sort as string | undefined,
    };
  }

  mapResult(result: unknown): unknown {
    const page = result as {
      content: unknown[];
      hasNext: boolean;
      hasPrevious: boolean;
      totalElements: number;
      totalPages: number;
      page: number;
      size: number;
    };
    return {
      content: page.content,
      pageInfo: {
        hasNextPage: page.hasNext,
        hasPreviousPage: page.hasPrevious,
        totalElements: page.totalElements,
        totalPages: page.totalPages,
        page: page.page,
        size: page.size,
      },
    };
  }
}

/**
 * Relay cursor pagination adapter.
 * Generates Connection/Edge/PageInfo SDL per the Relay Connection spec.
 */
export class RelayCursorPaginationAdapter implements GraphQLPaginationAdapter {
  readonly name = "cursor";

  generateSharedTypes(): string {
    return `type RelayPageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}`;
  }

  generateConnectionType(typeName: string): string {
    return `type ${typeName}Edge {
  node: ${typeName}!
  cursor: String!
}

type ${typeName}Connection {
  edges: [${typeName}Edge!]!
  pageInfo: RelayPageInfo!
  totalCount: Int!
}`;
  }

  generateQueryArgs(): string {
    return "first: Int, after: String, last: Int, before: String";
  }

  mapResolverArgs(args: Record<string, unknown>): {
    first?: number;
    after?: string;
    last?: number;
    before?: string;
  } {
    return {
      first: args.first as number | undefined,
      after: args.after as string | undefined,
      last: args.last as number | undefined,
      before: args.before as string | undefined,
    };
  }

  mapResult(result: unknown): unknown {
    // CursorPage already matches the GraphQL Connection shape
    return result;
  }
}

/**
 * Keyset pagination adapter — forward-only, simpler than Relay.
 */
export class KeysetPaginationAdapter implements GraphQLPaginationAdapter {
  readonly name = "keyset";

  generateSharedTypes(): string {
    return ""; // No shared types needed beyond entity-specific ones
  }

  generateConnectionType(typeName: string): string {
    return `type ${typeName}KeysetPage {
  content: [${typeName}!]!
  size: Int!
  hasNext: Boolean!
  lastValue: String
  lastId: String
}`;
  }

  generateQueryArgs(): string {
    return "size: Int = 20, sortColumn: String!, sortDirection: String = \"ASC\", afterValue: String, afterId: String";
  }

  mapResolverArgs(args: Record<string, unknown>): {
    size: number;
    sortColumn: string;
    sortDirection: "ASC" | "DESC";
    afterValue?: string;
    afterId?: string;
  } {
    return {
      size: (args.size as number) ?? 20,
      sortColumn: args.sortColumn as string,
      sortDirection: ((args.sortDirection as string) ?? "ASC").toUpperCase() as "ASC" | "DESC",
      afterValue: args.afterValue as string | undefined,
      afterId: args.afterId as string | undefined,
    };
  }

  mapResult(result: unknown): unknown {
    const page = result as {
      content: unknown[];
      size: number;
      hasNext: boolean;
      lastValue: unknown;
      lastId: unknown;
    };
    return {
      content: page.content,
      size: page.size,
      hasNext: page.hasNext,
      lastValue: page.lastValue != null ? String(page.lastValue) : null,
      lastId: page.lastId != null ? String(page.lastId) : null,
    };
  }
}

/**
 * Get the default pagination adapter (offset).
 */
export function getDefaultPaginationAdapter(): GraphQLPaginationAdapter {
  return new OffsetPaginationAdapter();
}
