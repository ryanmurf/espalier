/**
 * Converts a number[] to a pgvector-compatible string literal, e.g. "[0.1,0.2,0.3]".
 * Validates that every element is a finite number.
 *
 * @throws {Error} if any element is not a finite number
 */
export function toVectorLiteral(vector: number[]): string {
  for (let i = 0; i < vector.length; i++) {
    if (typeof vector[i] !== "number" || !Number.isFinite(vector[i])) {
      throw new Error(`Vector element at index ${i} must be a finite number, got: ${vector[i]}`);
    }
  }
  return `[${vector.join(",")}]`;
}
