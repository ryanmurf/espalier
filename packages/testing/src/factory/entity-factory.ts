/**
 * EntityFactory — Build test entities with sensible defaults and overrides.
 * Full implementation coming in DEV-2.
 */
export class EntityFactory<T> {
  constructor(private readonly _entityClass: new (...args: unknown[]) => T) {}

  build(_overrides?: Partial<T>): T {
    return new this._entityClass();
  }
}
