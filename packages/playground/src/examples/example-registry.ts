import { builtInExamples } from "./built-in-examples.js";
import type { PlaygroundExample } from "./types.js";

export class ExampleRegistry {
  private readonly examples: Map<string, PlaygroundExample> = new Map();

  constructor(loadBuiltIn = true) {
    if (loadBuiltIn) {
      for (const example of builtInExamples) {
        this.register(example);
      }
    }
  }

  register(example: PlaygroundExample): void {
    this.examples.set(example.id, example);
  }

  getAll(): PlaygroundExample[] {
    return [...this.examples.values()];
  }

  getByCategory(category: string): PlaygroundExample[] {
    return [...this.examples.values()].filter((e) => e.category === category);
  }

  getById(id: string): PlaygroundExample | undefined {
    return this.examples.get(id);
  }
}
