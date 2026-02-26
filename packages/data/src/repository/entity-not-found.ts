export class EntityNotFoundException extends Error {
  readonly entityName: string;
  readonly id: unknown;

  constructor(entityName: string, id: unknown) {
    super(
      `Entity ${entityName} with id ${String(id)} was not found. The entity may have been deleted by another process.`,
    );
    this.name = "EntityNotFoundException";
    this.entityName = entityName;
    this.id = id;
  }
}
