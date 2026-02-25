export interface ProjectionOptions {
  entity: new (...args: any[]) => any;
}

const projectionMetadata = new WeakMap<object, ProjectionOptions>();

export function Projection(options: ProjectionOptions) {
  return function <T extends abstract new (...args: any[]) => any>(
    target: T,
    _context: ClassDecoratorContext<T>,
  ): T {
    projectionMetadata.set(target, options);
    return target;
  };
}

export function getProjectionMetadata(
  target: object,
): ProjectionOptions | undefined {
  return projectionMetadata.get(target);
}
