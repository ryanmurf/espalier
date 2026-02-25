export class OptimisticLockException extends Error {
  readonly entityName: string;
  readonly id: unknown;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(
    entityName: string,
    id: unknown,
    expectedVersion: number,
    actualVersion: number | null,
  ) {
    const detail = actualVersion === null
      ? "entity was deleted by another transaction"
      : `expected version ${expectedVersion} but found ${actualVersion}`;
    super(
      `Optimistic lock conflict on ${entityName} with id ${String(id)}: ${detail}.`,
    );
    this.name = "OptimisticLockException";
    this.entityName = entityName;
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
