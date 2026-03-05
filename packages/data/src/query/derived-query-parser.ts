export type QueryOperator =
  | "Equals"
  | "Like"
  | "StartingWith"
  | "EndingWith"
  | "Containing"
  | "GreaterThan"
  | "GreaterThanEqual"
  | "LessThan"
  | "LessThanEqual"
  | "Between"
  | "In"
  | "NotIn"
  | "IsNull"
  | "IsNotNull"
  | "Not"
  | "True"
  | "False"
  | "SimilarTo";

export interface PropertyExpression {
  property: string;
  operator: QueryOperator;
  paramCount: number;
}

export interface OrderByExpression {
  property: string;
  direction: "Asc" | "Desc";
}

export interface DerivedQueryDescriptor {
  action: "find" | "count" | "delete" | "exists";
  distinct: boolean;
  properties: PropertyExpression[];
  connector: "And" | "Or";
  orderBy?: OrderByExpression[];
  limit?: number;
}

const OPERATOR_PARAM_COUNT: Record<QueryOperator, number> = {
  Equals: 1,
  Like: 1,
  StartingWith: 1,
  EndingWith: 1,
  Containing: 1,
  GreaterThan: 1,
  GreaterThanEqual: 1,
  LessThan: 1,
  LessThanEqual: 1,
  Between: 2,
  In: 1,
  NotIn: 1,
  IsNull: 0,
  IsNotNull: 0,
  Not: 1,
  True: 0,
  False: 0,
  SimilarTo: 1,
};

// Operators sorted by length descending so longer suffixes match first
const OPERATORS_BY_LENGTH: QueryOperator[] = (
  Object.keys(OPERATOR_PARAM_COUNT) as QueryOperator[]
).sort((a, b) => b.length - a.length);

interface PrefixResult {
  action: "find" | "count" | "delete" | "exists";
  distinct: boolean;
  limit?: number;
}

function parsePrefix(methodName: string): { prefix: PrefixResult; rest: string } {
  // findDistinctBy...
  if (methodName.startsWith("findDistinctBy")) {
    const rest = methodName.slice("findDistinctBy".length);
    return { prefix: { action: "find", distinct: true }, rest };
  }
  if (methodName.startsWith("findDistinct")) {
    throw new Error(
      `Invalid derived query method name "${methodName}": ` +
        `expected "By" after "findDistinct".`,
    );
  }

  // findFirst<N>By... or findFirstBy... or findTop<N>By... or findTopBy...
  const firstMatch = methodName.match(/^find(?:First|Top)(\d*)By(.*)$/);
  if (firstMatch) {
    const limit = firstMatch[1] ? parseInt(firstMatch[1], 10) : 1;
    return {
      prefix: { action: "find", distinct: false, limit },
      rest: firstMatch[2],
    };
  }

  // findAllBy... or findBy...
  if (methodName.startsWith("findAllBy")) {
    return {
      prefix: { action: "find", distinct: false },
      rest: methodName.slice("findAllBy".length),
    };
  }
  if (methodName.startsWith("findBy")) {
    return {
      prefix: { action: "find", distinct: false },
      rest: methodName.slice("findBy".length),
    };
  }

  // countBy...
  if (methodName.startsWith("countBy")) {
    return {
      prefix: { action: "count", distinct: false },
      rest: methodName.slice("countBy".length),
    };
  }

  // deleteBy... or removeBy...
  if (methodName.startsWith("deleteBy")) {
    return {
      prefix: { action: "delete", distinct: false },
      rest: methodName.slice("deleteBy".length),
    };
  }
  if (methodName.startsWith("removeBy")) {
    return {
      prefix: { action: "delete", distinct: false },
      rest: methodName.slice("removeBy".length),
    };
  }

  // existsBy...
  if (methodName.startsWith("existsBy")) {
    return {
      prefix: { action: "exists", distinct: false },
      rest: methodName.slice("existsBy".length),
    };
  }

  throw new Error(
    `Invalid derived query method name "${methodName}": ` +
      `must start with findBy, findAllBy, findFirstBy, findTopBy, findDistinctBy, ` +
      `countBy, deleteBy, removeBy, or existsBy.`,
  );
}

function extractOrderBy(predicate: string): {
  predicatePart: string;
  orderBy: OrderByExpression[];
} {
  const orderByIdx = predicate.indexOf("OrderBy");
  if (orderByIdx === -1) {
    return { predicatePart: predicate, orderBy: [] };
  }

  const predicatePart = predicate.slice(0, orderByIdx);
  const orderByPart = predicate.slice(orderByIdx + "OrderBy".length);

  if (!orderByPart) {
    throw new Error(
      `Invalid OrderBy clause: expected property name after "OrderBy".`,
    );
  }

  const orderBy: OrderByExpression[] = [];

  // Split on direction suffixes. Pattern: PropertyAsc or PropertyDesc
  // Multiple order-by: OrderByAgeDescNameAsc
  // Direction suffixes must be at a word boundary: followed by end-of-string
  // or an uppercase letter (start of next property name).
  // Property names may contain "Asc" or "Desc" as substrings (e.g. "Description"),
  // so we must only match at valid boundaries.
  let remaining = orderByPart;
  while (remaining.length > 0) {
    // Find the earliest valid direction suffix match across both "Desc" and "Asc"
    let bestIdx = -1;
    let bestDir: "Asc" | "Desc" = "Asc";

    for (const dir of ["Desc", "Asc"] as const) {
      let searchFrom = 1; // property must be at least 1 char
      while (searchFrom < remaining.length) {
        const idx = remaining.indexOf(dir, searchFrom);
        if (idx === -1) break;

        const afterIdx = idx + dir.length;
        const atBoundary = afterIdx === remaining.length ||
          (remaining[afterIdx] >= "A" && remaining[afterIdx] <= "Z");

        if (atBoundary && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestDir = dir;
          break; // first valid match for this direction, move to next direction
        }

        searchFrom = idx + 1;
      }
    }

    let propPart: string;
    let direction: "Asc" | "Desc" = "Asc";

    if (bestIdx === -1) {
      // No explicit direction — default Asc, entire remainder is property
      propPart = remaining;
      remaining = "";
    } else {
      propPart = remaining.slice(0, bestIdx);
      direction = bestDir;
      remaining = remaining.slice(bestIdx + bestDir.length);
    }

    if (!propPart) {
      throw new Error(
        `Invalid OrderBy clause: expected property name before direction.`,
      );
    }

    orderBy.push({
      property: propPart[0].toLowerCase() + propPart.slice(1),
      direction,
    });
  }

  return { predicatePart, orderBy };
}

function parsePropertyExpression(expr: string): PropertyExpression {
  // Try to match operator suffixes, longest first
  for (const op of OPERATORS_BY_LENGTH) {
    if (expr.endsWith(op)) {
      const propPart = expr.slice(0, expr.length - op.length);
      if (propPart.length > 0) {
        return {
          property: propPart[0].toLowerCase() + propPart.slice(1),
          operator: op,
          paramCount: OPERATOR_PARAM_COUNT[op],
        };
      }
    }
  }

  // No operator suffix — default to Equals
  if (expr.length === 0) {
    throw new Error(`Invalid property expression: empty property name.`);
  }

  return {
    property: expr[0].toLowerCase() + expr.slice(1),
    operator: "Equals",
    paramCount: 1,
  };
}

function splitProperties(
  predicate: string,
): { parts: string[]; connector: "And" | "Or" } {
  // Determine connector: we split on "And" or "Or", but not both
  // We need to find word-boundary splits (uppercase after And/Or)
  // Strategy: try splitting on "And" first, then "Or"
  // If both appear, the first one encountered determines the connector

  const andPositions = findConnectorPositions(predicate, "And");
  const orPositions = findConnectorPositions(predicate, "Or");

  if (andPositions.length === 0 && orPositions.length === 0) {
    return { parts: [predicate], connector: "And" };
  }

  if (andPositions.length > 0 && orPositions.length === 0) {
    return { parts: splitAtPositions(predicate, andPositions, 3), connector: "And" };
  }

  if (orPositions.length > 0 && andPositions.length === 0) {
    return { parts: splitAtPositions(predicate, orPositions, 2), connector: "Or" };
  }

  // Both present — use "And" as the connector (Spring Data convention)
  return { parts: splitAtPositions(predicate, andPositions, 3), connector: "And" };
}

function findConnectorPositions(predicate: string, connector: string): number[] {
  const positions: number[] = [];
  let searchFrom = 0;

  while (searchFrom < predicate.length) {
    const idx = predicate.indexOf(connector, searchFrom);
    if (idx === -1) break;

    // The connector must be at a word boundary:
    // - character before connector must be lowercase (end of a property/operator word)
    // - character after connector must be uppercase (start of next property)
    const charBefore = idx > 0 ? predicate[idx - 1] : undefined;
    const charAfter = idx + connector.length < predicate.length
      ? predicate[idx + connector.length]
      : undefined;

    const validBefore = idx === 0 || (charBefore !== undefined && charBefore >= "a" && charBefore <= "z");
    const validAfter = charAfter === undefined || (charAfter >= "A" && charAfter <= "Z");

    if (validBefore && validAfter) {
      positions.push(idx);
      searchFrom = idx + connector.length;
    } else {
      searchFrom = idx + 1;
    }
  }

  return positions;
}

function splitAtPositions(str: string, positions: number[], connectorLength: number): string[] {
  const parts: string[] = [];
  let start = 0;

  for (const pos of positions) {
    parts.push(str.slice(start, pos));
    start = pos + connectorLength;
  }
  parts.push(str.slice(start));

  return parts.filter((p) => p.length > 0);
}

export function parseDerivedQueryMethod(
  methodName: string,
): DerivedQueryDescriptor {
  if (!methodName) {
    throw new Error(`Invalid derived query method name: method name is empty.`);
  }

  const { prefix, rest } = parsePrefix(methodName);

  if (!rest) {
    throw new Error(
      `Invalid derived query method name "${methodName}": ` +
        `no property predicates found after "By".`,
    );
  }

  const { predicatePart, orderBy } = extractOrderBy(rest);

  if (!predicatePart) {
    throw new Error(
      `Invalid derived query method name "${methodName}": ` +
        `no property predicates found before "OrderBy".`,
    );
  }

  const { parts, connector } = splitProperties(predicatePart);
  const properties = parts.map(parsePropertyExpression);

  if (properties.length === 0) {
    throw new Error(
      `Invalid derived query method name "${methodName}": ` +
        `no property predicates could be parsed from "${predicatePart}".`,
    );
  }

  return {
    action: prefix.action,
    distinct: prefix.distinct,
    properties,
    connector,
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(prefix.limit !== undefined ? { limit: prefix.limit } : {}),
  };
}
