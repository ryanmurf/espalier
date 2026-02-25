export enum IsolationLevel {
  READ_UNCOMMITTED = "READ UNCOMMITTED",
  READ_COMMITTED = "READ COMMITTED",
  REPEATABLE_READ = "REPEATABLE READ",
  SERIALIZABLE = "SERIALIZABLE",
}

export interface Transaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  setSavepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
}
