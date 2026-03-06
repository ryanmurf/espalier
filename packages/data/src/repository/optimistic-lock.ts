export class OptimisticLockException extends Error {
  readonly entityName: string;
  readonly id: unknown;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(entityName: string, id: unknown, expectedVersion: number, actualVersion: number | null) {
    const detail =
      actualVersion === null
        ? "entity was deleted by another transaction"
        : `expected version ${expectedVersion} but found ${actualVersion}`;
    super(`Optimistic lock conflict on ${entityName} with id ${String(id)}: ${detail}.`);
    this.name = "OptimisticLockException";
    this.entityName = entityName;
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }

  /** Returns a generic message safe for external API responses. */
  toSafeString(): string {
    return "Optimistic lock conflict: entity was concurrently modified";
  }

  /** Omits entity ID, version, and entity name from JSON serialization. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: "Optimistic lock conflict",
    };
  }
}
