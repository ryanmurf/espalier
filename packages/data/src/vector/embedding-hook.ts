import type { LifecycleEvent } from "../decorators/lifecycle.js";
import { addLifecycleCallback } from "../decorators/lifecycle.js";

/**
 * A function that converts text into a vector embedding.
 */
export type EmbeddingProvider = (text: string) => Promise<number[]>;

/**
 * Options for creating an embedding hook that auto-generates vectors before persist.
 */
export interface EmbeddingHookOptions {
  /** The @Vector field to populate */
  vectorField: string;
  /** Source fields to concatenate for embedding input */
  sourceFields: string[];
  /** The embedding provider function */
  provider: EmbeddingProvider;
  /** Separator for concatenating source fields (default: " ") */
  separator?: string;
  /** Only re-embed if source fields changed (default: true) */
  onlyOnChange?: boolean;
}

/**
 * Reads source fields from an entity and concatenates them into a single string.
 */
function buildSourceText(entity: Record<string, unknown>, sourceFields: string[], separator: string): string {
  return sourceFields
    .map((field) => {
      const value = entity[field];
      return value == null ? "" : String(value);
    })
    .join(separator);
}

/**
 * Creates a @PrePersist / @PreUpdate compatible callback function that
 * auto-generates embeddings from source fields before entity persistence.
 *
 * The returned function is async and can be used as the body of a lifecycle
 * callback method on an entity class.
 *
 * @example
 * ```ts
 * const embedHook = createEmbeddingHook({
 *   vectorField: "embedding",
 *   sourceFields: ["title", "content"],
 *   provider: async (text) => openai.embed(text),
 * });
 *
 * @Table("documents")
 * class Document {
 *   @Id @Column() id!: string;
 *   @Column() title!: string;
 *   @Column() content!: string;
 *   @Vector({ dimensions: 1536, metric: "cosine" }) embedding!: number[];
 *
 *   @PrePersist
 *   async generateEmbedding() {
 *     await embedHook.call(this);
 *   }
 * }
 * ```
 */
export function createEmbeddingHook(options: EmbeddingHookOptions): (this: Record<string, unknown>) => Promise<void> {
  const {
    vectorField,
    sourceFields,
    provider,
    separator = " ",
    onlyOnChange = true,
  } = options;

  if (sourceFields.length === 0) {
    throw new Error("EmbeddingHookOptions.sourceFields must contain at least one field");
  }

  // Track previous source text per entity instance to support onlyOnChange
  const previousTextMap = new WeakMap<object, string>();

  return async function embeddingHook(this: Record<string, unknown>): Promise<void> {
    const text = buildSourceText(this, sourceFields, separator);

    // Skip empty source text
    if (text.trim().length === 0) {
      return;
    }

    // If onlyOnChange is enabled, skip if source text hasn't changed
    if (onlyOnChange) {
      const previousText = previousTextMap.get(this);
      if (previousText !== undefined && previousText === text) {
        return;
      }
    }

    const embedding = await provider(text);
    this[vectorField] = embedding;

    // Remember current text for future change detection
    previousTextMap.set(this, text);
  };
}

// Counter for generating unique method names
let hookCounter = 0;

/**
 * Programmatically registers an embedding hook on an entity class.
 *
 * This attaches a @PrePersist and @PreUpdate lifecycle callback that
 * auto-generates embeddings from source fields before persistence.
 *
 * @example
 * ```ts
 * registerEmbeddingHook(Document, {
 *   vectorField: "embedding",
 *   sourceFields: ["title", "content"],
 *   provider: async (text) => openai.embed(text),
 * });
 * ```
 */
export function registerEmbeddingHook(
  entityClass: new (...args: unknown[]) => unknown,
  options: EmbeddingHookOptions,
): void {
  const hook = createEmbeddingHook(options);
  const methodName = `__embeddingHook_${options.vectorField}_${hookCounter++}`;

  // Attach the hook function to the entity prototype
  Object.defineProperty(entityClass.prototype, methodName, {
    value: hook,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Register it as both PrePersist and PreUpdate lifecycle callback
  const events: LifecycleEvent[] = ["PrePersist", "PreUpdate"];
  for (const event of events) {
    addLifecycleCallback(entityClass, event, methodName);
  }
}
