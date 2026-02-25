export interface ParsedNamedQuery {
  sql: string;
  paramOrder: string[];
}

const NAMED_PARAM_REGEX = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function parseNamedParams(sql: string): ParsedNamedQuery {
  const paramOrder: string[] = [];
  const paramIndexMap = new Map<string, number>();

  const converted = sql.replace(NAMED_PARAM_REGEX, (_, name: string) => {
    let idx = paramIndexMap.get(name);
    if (idx === undefined) {
      paramOrder.push(name);
      idx = paramOrder.length;
      paramIndexMap.set(name, idx);
    }
    return `$${idx}`;
  });

  return { sql: converted, paramOrder };
}
