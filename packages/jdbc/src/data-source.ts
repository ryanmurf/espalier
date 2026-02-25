import type { Connection } from "./connection.js";

export interface DataSource {
  getConnection(): Promise<Connection>;
  close(): Promise<void>;
}
