import type { PreparedStatement, Statement } from "./statement.js";
import type { IsolationLevel, Transaction } from "./transaction.js";

export interface Connection {
  createStatement(): Statement;
  prepareStatement(sql: string): PreparedStatement;
  beginTransaction(isolation?: IsolationLevel): Promise<Transaction>;
  close(): Promise<void>;
  isClosed(): boolean;
}
