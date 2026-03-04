import type { RouteDefinition, RestRequest } from "./handler.js";

/**
 * Minimal Express-compatible types to avoid hard dependency.
 */
interface ExpressRequest {
  params: Record<string, string>;
  query: Record<string, any>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
  send(): void;
}

interface ExpressRouter {
  get(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  post(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  put(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  delete(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  patch(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
}

/**
 * Mount generated routes onto an Express Router.
 * Pass in your own router instance to avoid importing Express.
 *
 * @example
 * ```ts
 * import { Router } from "express";
 * const router = Router();
 * mountExpressRoutes(router, routes);
 * app.use("/api", router);
 * ```
 */
export function mountExpressRoutes(router: ExpressRouter, routes: RouteDefinition[]): void {
  for (const route of routes) {
    const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
    router[method](route.path, async (req: ExpressRequest, res: ExpressResponse) => {
      try {
        const restReq: RestRequest = {
          params: req.params,
          query: req.query,
          body: req.body,
          headers: req.headers,
        };
        const result = await route.handler(restReq);
        if (result.body !== undefined) {
          res.status(result.status).json(result.body);
        } else {
          res.status(result.status).send();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.status(500).json({ error: message });
      }
    });
  }
}
