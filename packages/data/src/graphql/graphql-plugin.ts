import type { Plugin, PluginContext } from "../plugin/plugin.js";
import { GraphQLSchemaGenerator } from "./schema-generator.js";
import type { GraphQLSchemaOptions, GeneratedGraphQLSchema } from "./schema-generator.js";

/**
 * Configuration for the GraphQL plugin.
 */
export interface GraphQLPluginConfig extends GraphQLSchemaOptions {
  /** Entity classes to generate schema for. */
  entities: Array<new (...args: any[]) => any>;
}

/**
 * Plugin that generates GraphQL SDL from entity metadata.
 */
export class GraphQLPlugin implements Plugin {
  readonly name = "graphql";
  readonly version = "1.0.0";

  private readonly config: GraphQLPluginConfig;
  private schema: GeneratedGraphQLSchema | undefined;

  constructor(config: GraphQLPluginConfig) {
    this.config = config;
  }

  async init(context: PluginContext): Promise<void> {
    const generator = new GraphQLSchemaGenerator(this.config);
    this.schema = generator.generate(this.config.entities);

    context.addHook({
      type: "onEntityRegistered",
      handler: () => {
        // Regenerate schema when entities change
        this.schema = generator.generate(this.config.entities);
      },
    });
  }

  /**
   * Get the generated schema.
   */
  getSchema(): GeneratedGraphQLSchema | undefined {
    return this.schema;
  }

  /**
   * Get the SDL string.
   */
  getSdl(): string {
    return this.schema?.sdl ?? "";
  }
}
