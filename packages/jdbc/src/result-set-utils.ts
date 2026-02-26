import type { ResultSet } from "./result-set.js";

export async function toArray(rs: ResultSet): Promise<Record<string, unknown>[]> {
  try {
    const results: Record<string, unknown>[] = [];
    while (await rs.next()) {
      results.push(rs.getRow());
    }
    return results;
  } finally {
    await rs.close();
  }
}

export async function* mapResultSet<T>(
  rs: ResultSet,
  fn: (row: Record<string, unknown>) => T,
): AsyncIterable<T> {
  try {
    while (await rs.next()) {
      yield fn(rs.getRow());
    }
  } finally {
    await rs.close();
  }
}

export async function* filterResultSet(
  rs: ResultSet,
  predicate: (row: Record<string, unknown>) => boolean,
): AsyncIterable<Record<string, unknown>> {
  try {
    while (await rs.next()) {
      const row = rs.getRow();
      if (predicate(row)) {
        yield row;
      }
    }
  } finally {
    await rs.close();
  }
}

export async function reduceResultSet<T>(
  rs: ResultSet,
  reducer: (acc: T, row: Record<string, unknown>) => T,
  initial: T,
): Promise<T> {
  try {
    let acc = initial;
    while (await rs.next()) {
      acc = reducer(acc, rs.getRow());
    }
    return acc;
  } finally {
    await rs.close();
  }
}

export async function forEachResultSet(
  rs: ResultSet,
  fn: (row: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  try {
    while (await rs.next()) {
      const result = fn(rs.getRow());
      if (result instanceof Promise) {
        await result;
      }
    }
  } finally {
    await rs.close();
  }
}
