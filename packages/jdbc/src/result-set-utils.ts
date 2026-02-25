import type { ResultSet } from "./result-set.js";

export async function toArray(rs: ResultSet): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  while (await rs.next()) {
    results.push(rs.getRow());
  }
  return results;
}

export async function* mapResultSet<T>(
  rs: ResultSet,
  fn: (row: Record<string, unknown>) => T,
): AsyncIterable<T> {
  while (await rs.next()) {
    yield fn(rs.getRow());
  }
}

export async function* filterResultSet(
  rs: ResultSet,
  predicate: (row: Record<string, unknown>) => boolean,
): AsyncIterable<Record<string, unknown>> {
  while (await rs.next()) {
    const row = rs.getRow();
    if (predicate(row)) {
      yield row;
    }
  }
}

export async function reduceResultSet<T>(
  rs: ResultSet,
  reducer: (acc: T, row: Record<string, unknown>) => T,
  initial: T,
): Promise<T> {
  let acc = initial;
  while (await rs.next()) {
    acc = reducer(acc, rs.getRow());
  }
  return acc;
}

export async function forEachResultSet(
  rs: ResultSet,
  fn: (row: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  while (await rs.next()) {
    const result = fn(rs.getRow());
    if (result instanceof Promise) {
      await result;
    }
  }
}
