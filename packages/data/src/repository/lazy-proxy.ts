/**
 * Proxy-based lazy loading for relation fields.
 *
 * When a relation is marked as `lazy: true`, the field value is set to a lazy
 * proxy instead of being eagerly loaded. Accessing any property on the proxy
 * triggers an async database query to load the related entity/collection.
 *
 * For single-valued relations (@ManyToOne, @OneToOne): the proxy wraps an
 * object that, on first property access, loads and returns the related entity.
 *
 * For collection relations (@OneToMany, @ManyToMany): the proxy wraps an
 * array-like object that, on first access to array methods/properties, loads
 * the related collection.
 */

const LAZY_MARKER = Symbol.for("espalier:lazy-proxy");
const LAZY_INITIALIZED = Symbol.for("espalier:lazy-initialized");
const LAZY_VALUE = Symbol.for("espalier:lazy-value");
const LAZY_INITIALIZER = Symbol.for("espalier:lazy-initializer");
const LAZY_PROMISE = Symbol.for("espalier:lazy-promise");

export type LazyInitializer<T> = () => Promise<T>;

/**
 * Creates a lazy proxy for a single-valued relation (e.g., @ManyToOne, @OneToOne).
 * On first access to any property (other than internal symbols and `then`),
 * the initializer is called to load the related entity.
 *
 * The proxy is thenable: `await entity.relation` triggers the load and
 * resolves to the loaded value.
 */
export function createLazySingleProxy<T extends object>(initializer: LazyInitializer<T | null>): T {
  const state = {
    [LAZY_MARKER]: true,
    [LAZY_INITIALIZED]: false,
    [LAZY_VALUE]: undefined as T | null | undefined,
    [LAZY_INITIALIZER]: initializer,
    [LAZY_PROMISE]: undefined as Promise<T | null> | undefined,
  };

  function ensureInitialized(): Promise<T | null> {
    if (state[LAZY_INITIALIZED]) {
      return Promise.resolve(state[LAZY_VALUE] as T | null);
    }
    if (!state[LAZY_PROMISE]) {
      state[LAZY_PROMISE] = initializer().then((value) => {
        state[LAZY_VALUE] = value;
        state[LAZY_INITIALIZED] = true;
        state[LAZY_PROMISE] = undefined;
        return value;
      });
    }
    return state[LAZY_PROMISE]!;
  }

  const proxy = new Proxy({} as T, {
    get(_target, prop, receiver) {
      // Internal symbols for lazy proxy inspection
      if (prop === LAZY_MARKER) return true;
      if (prop === LAZY_INITIALIZED) return state[LAZY_INITIALIZED];
      if (prop === LAZY_VALUE) return state[LAZY_VALUE];
      if (prop === LAZY_INITIALIZER) return state[LAZY_INITIALIZER];

      // Thenable: allow `await entity.relation` to trigger load
      if (prop === "then") {
        // Eagerly call ensureInitialized so the initializer runs synchronously
        // when `then` is first accessed (before the microtask scheduler calls it).
        const promise = ensureInitialized();
        return (resolve: (value: T | null) => void, reject: (reason: unknown) => void) => {
          promise.then(resolve, reject);
        };
      }

      // If already initialized, delegate to the loaded value
      if (state[LAZY_INITIALIZED]) {
        const value = state[LAZY_VALUE];
        if (value === null || value === undefined) return undefined;
        const result = Reflect.get(value as object, prop, receiver);
        return typeof result === "function" ? result.bind(value) : result;
      }

      // Not yet initialized: return undefined for synchronous access
      return undefined;
    },

    set(_target, prop, value) {
      if (state[LAZY_INITIALIZED]) {
        const loaded = state[LAZY_VALUE];
        if (loaded !== null && loaded !== undefined) {
          return Reflect.set(loaded as object, prop, value);
        }
      }
      return true;
    },

    has(_target, prop) {
      if (prop === LAZY_MARKER) return true;
      if (state[LAZY_INITIALIZED] && state[LAZY_VALUE]) {
        return Reflect.has(state[LAZY_VALUE] as object, prop);
      }
      return false;
    },

    ownKeys() {
      if (state[LAZY_INITIALIZED] && state[LAZY_VALUE]) {
        return Reflect.ownKeys(state[LAZY_VALUE] as object);
      }
      return [];
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (state[LAZY_INITIALIZED] && state[LAZY_VALUE]) {
        return Reflect.getOwnPropertyDescriptor(state[LAZY_VALUE] as object, prop);
      }
      return undefined;
    },
  });

  return proxy;
}

/**
 * Creates a lazy proxy for a collection relation (e.g., @OneToMany, @ManyToMany).
 * On first access to any array property or method, the initializer is called
 * to load the related collection.
 *
 * The proxy is thenable: `await entity.collection` triggers the load and
 * resolves to the loaded array.
 */
export function createLazyCollectionProxy<T>(initializer: LazyInitializer<T[]>): T[] {
  const state = {
    [LAZY_MARKER]: true,
    [LAZY_INITIALIZED]: false,
    [LAZY_VALUE]: undefined as T[] | undefined,
    [LAZY_INITIALIZER]: initializer,
    [LAZY_PROMISE]: undefined as Promise<T[]> | undefined,
  };

  function ensureInitialized(): Promise<T[]> {
    if (state[LAZY_INITIALIZED]) {
      return Promise.resolve(state[LAZY_VALUE] as T[]);
    }
    if (!state[LAZY_PROMISE]) {
      state[LAZY_PROMISE] = initializer().then((value) => {
        state[LAZY_VALUE] = value;
        state[LAZY_INITIALIZED] = true;
        state[LAZY_PROMISE] = undefined;
        return value;
      });
    }
    return state[LAZY_PROMISE]!;
  }

  const proxy = new Proxy([] as T[], {
    get(_target, prop, receiver) {
      // Internal symbols for lazy proxy inspection
      if (prop === LAZY_MARKER) return true;
      if (prop === LAZY_INITIALIZED) return state[LAZY_INITIALIZED];
      if (prop === LAZY_VALUE) return state[LAZY_VALUE];
      if (prop === LAZY_INITIALIZER) return state[LAZY_INITIALIZER];

      // Thenable: allow `await entity.collection` to trigger load
      if (prop === "then") {
        const promise = ensureInitialized();
        return (resolve: (value: T[]) => void, reject: (reason: unknown) => void) => {
          promise.then(resolve, reject);
        };
      }

      // If already initialized, delegate to the loaded array
      if (state[LAZY_INITIALIZED]) {
        const arr = state[LAZY_VALUE] as T[];
        const result = Reflect.get(arr, prop, receiver);
        return typeof result === "function" ? result.bind(arr) : result;
      }

      // Not yet initialized: return sensible defaults for array-like access
      if (prop === "length") return 0;
      if (prop === Symbol.iterator) return [][Symbol.iterator];

      return undefined;
    },

    set(_target, prop, value) {
      if (state[LAZY_INITIALIZED]) {
        return Reflect.set(state[LAZY_VALUE] as T[], prop, value);
      }
      return true;
    },

    has(_target, prop) {
      if (prop === LAZY_MARKER) return true;
      if (state[LAZY_INITIALIZED] && state[LAZY_VALUE]) {
        return Reflect.has(state[LAZY_VALUE] as T[], prop);
      }
      return false;
    },

    ownKeys() {
      if (state[LAZY_INITIALIZED] && state[LAZY_VALUE]) {
        return Reflect.ownKeys(state[LAZY_VALUE] as T[]);
      }
      return [];
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (state[LAZY_INITIALIZED] && state[LAZY_VALUE]) {
        return Reflect.getOwnPropertyDescriptor(state[LAZY_VALUE] as T[], prop);
      }
      return undefined;
    },
  });

  return proxy;
}

/**
 * Returns true if the given value is a lazy proxy created by this module.
 */
export function isLazyProxy(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj !== "object" && typeof obj !== "function") return false;
  try {
    return (obj as Record<symbol, unknown>)[LAZY_MARKER] === true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the lazy proxy has been initialized (loaded from DB).
 * Returns true for non-proxy values (they are by definition "initialized").
 */
export function isInitialized(obj: unknown): boolean {
  if (!isLazyProxy(obj)) return true;
  return (obj as Record<symbol, unknown>)[LAZY_INITIALIZED] === true;
}

/**
 * Force-initializes a lazy proxy by triggering its loader.
 * Returns the loaded value. For non-proxy values, returns the value as-is.
 */
export async function initializeProxy<T>(proxy: T): Promise<T> {
  if (!isLazyProxy(proxy)) return proxy;
  // Trigger the proxy's own then() handler, which calls ensureInitialized()
  // and updates the proxy's internal state.
  const value = await (proxy as unknown as PromiseLike<T>);
  return value;
}
