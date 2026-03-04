import type { Plugin, PluginContext } from "../plugin/plugin.js";
import type { RouteDefinition } from "./handler.js";
import type { RestEntityRegistration, RouteGeneratorOptions } from "./route-generator.js";
import { RouteGenerator } from "./route-generator.js";

/**
 * Configuration for the REST plugin.
 */
export interface RestPluginConfig extends RouteGeneratorOptions {
  /** Entity/repository registrations. */
  registrations: RestEntityRegistration[];
}

/**
 * Plugin that generates REST route definitions from entity metadata.
 */
export class RestPlugin implements Plugin {
  readonly name = "rest";
  readonly version = "1.0.0";

  private readonly config: RestPluginConfig;
  private routes: RouteDefinition[] = [];

  constructor(config: RestPluginConfig) {
    this.config = config;
  }

  async init(context: PluginContext): Promise<void> {
    const generator = new RouteGenerator(this.config);
    this.routes = generator.generate(this.config.registrations);

    context.addHook({
      type: "onEntityRegistered",
      handler: () => {
        this.routes = generator.generate(this.config.registrations);
      },
    });
  }

  /**
   * Get the generated route definitions.
   */
  getRoutes(): RouteDefinition[] {
    return this.routes;
  }
}
