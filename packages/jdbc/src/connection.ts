import type { PreparedStatement, Statement } from "./statement.js";
import type { StatementCacheStats } from "./statement-cache.js";
import type { IsolationLevel, Transaction } from "./transaction.js";
import type { TypeConverterRegistry } from "./type-converter.js";

export interface Connection {
  createStatement(): Statement;
  prepareStatement(sql: string): PreparedStatement;
  beginTransaction(isolation?: IsolationLevel): Promise<Transaction>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface TypeAwareConnection extends Connection {
  getTypeConverterRegistry(): TypeConverterRegistry | undefined;
}

export interface CacheableConnection extends Connection {
  getStatementCacheStats(): StatementCacheStats;
  clearStatementCache(): Promise<void>;
}
