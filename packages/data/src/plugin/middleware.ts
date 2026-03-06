/**
 * Context passed to middleware functions.
 */
export interface MiddlewareContext {
  /** Operation being performed (e.g., "save", "findById", "delete"). */
  operation: string;
  /** Entity class involved. */
  entityClass: new (
    ...args: any[]
  ) => any;
  /** Arguments passed to the repository method. */
  args: unknown[];
  /** Arbitrary metadata for cross-middleware communication. */
  metadata: Map<string, unknown>;
}

/**
 * A middleware function that can intercept repository operations.
 * Call next() to continue the chain, or return directly to short-circuit.
 */
export type MiddlewareFn = (context: MiddlewareContext, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * Composes an array of middleware functions into a single function.
 * Middleware runs in registration order; the innermost call is the original operation.
 */
export function composeMiddleware(
  middlewares: MiddlewareFn[],
  operation: () => Promise<unknown>,
  context: MiddlewareContext,
): Promise<unknown> {
  let index = -1;

  function dispatch(i: number): Promise<unknown> {
    if (i <= index) {
      return Promise.reject(new Error("next() called multiple times"));
    }
    index = i;
    if (i >= middlewares.length) {
      return operation();
    }
    return middlewares[i](context, () => dispatch(i + 1));
  }

  return dispatch(0);
}
