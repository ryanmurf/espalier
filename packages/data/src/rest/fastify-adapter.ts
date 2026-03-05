import type { RouteDefinition, RestRequest } from "./handler.js";

/**
 * Minimal Fastify-compatible types to avoid hard dependency.
 */
interface FastifyRequest {
  params: Record<string, any>;
  query: Record<string, any>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface FastifyReply {
  status(code: number): FastifyReply;
  send(body?: unknown): void;
}

interface FastifyInstance {
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  post(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  put(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  delete(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  patch(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
}

/**
 * Register generated routes as a Fastify plugin.
 * Returns an async plugin function suitable for fastify.register().
 *
 * @example
 * ```ts
 * const plugin = createFastifyPlugin(routes);
 * fastify.register(plugin, { prefix: "/api" });
 * ```
 */
export function createFastifyPlugin(routes: RouteDefinition[]): (fastify: FastifyInstance) => Promise<void> {
  return async (fastify: FastifyInstance) => {
    for (const route of routes) {
      const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
      // Convert Express-style :id to Fastify-style :id (same format, no conversion needed)
      fastify[method](route.path, async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const restReq: RestRequest = {
            params: req.params as Record<string, string>,
            query: req.query as Record<string, string | string[] | undefined>,
            body: req.body,
            headers: req.headers,
          };
          const result = await route.handler(restReq);
          if (result.body !== undefined) {
            reply.status(result.status).send(result.body);
          } else {
            reply.status(result.status).send();
          }
        } catch (err) {
          reply.status(500).send({ error: "Internal Server Error" });
        }
      });
    }
  };
}
