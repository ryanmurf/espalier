export type LifecycleEvent =
  | "PrePersist"
  | "PostPersist"
  | "PreUpdate"
  | "PostUpdate"
  | "PreRemove"
  | "PostRemove"
  | "PostLoad";

const lifecycleMetadata = new WeakMap<object, Map<LifecycleEvent, (string | symbol)[]>>();

export function addLifecycleCallback(constructor: object, event: LifecycleEvent, methodName: string | symbol): void {
  if (!lifecycleMetadata.has(constructor)) {
    lifecycleMetadata.set(constructor, new Map());
  }
  const map = lifecycleMetadata.get(constructor)!;
  if (!map.has(event)) {
    map.set(event, []);
  }
  const callbacks = map.get(event)!;
  if (!callbacks.includes(methodName)) {
    callbacks.push(methodName);
  }
}

function createLifecycleDecorator(event: LifecycleEvent) {
  return <T extends (...args: any[]) => any>(_target: T, context: ClassMethodDecoratorContext): void => {
    const methodName = context.name;
    context.addInitializer(function () {
      const constructor = (this as Record<string, any>).constructor as object;
      addLifecycleCallback(constructor, event, methodName);
    });
  };
}

export const PrePersist = createLifecycleDecorator("PrePersist");
export const PostPersist = createLifecycleDecorator("PostPersist");
export const PreUpdate = createLifecycleDecorator("PreUpdate");
export const PostUpdate = createLifecycleDecorator("PostUpdate");
export const PreRemove = createLifecycleDecorator("PreRemove");
export const PostRemove = createLifecycleDecorator("PostRemove");
export const PostLoad = createLifecycleDecorator("PostLoad");

export function getLifecycleCallbacks(entityClass: object): Map<LifecycleEvent, (string | symbol)[]> {
  return lifecycleMetadata.get(entityClass) ?? new Map();
}
