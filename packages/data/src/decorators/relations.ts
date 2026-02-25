export interface ManyToOneOptions {
  target: () => new (...args: any[]) => any;
  joinColumn?: string;
  nullable?: boolean;
}

export interface ManyToOneRelation {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  joinColumn: string;
  nullable: boolean;
}

const manyToOneMetadata = new WeakMap<object, Map<string | symbol, ManyToOneRelation>>();

export function ManyToOne(options: ManyToOneOptions) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const fieldName = context.name;
    const joinColumn = options.joinColumn ?? `${String(fieldName)}_id`;
    const nullable = options.nullable ?? true;

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!manyToOneMetadata.has(constructor)) {
        manyToOneMetadata.set(constructor, new Map());
      }
      manyToOneMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        joinColumn,
        nullable,
      });
    });
  };
}

export function getManyToOneRelations(target: object): ManyToOneRelation[] {
  const map = manyToOneMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}
