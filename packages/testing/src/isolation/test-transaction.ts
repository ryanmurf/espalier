/**
 * TestTransaction — Transaction-based test isolation.
 * Wraps each test in a transaction that rolls back on completion.
 * Full implementation coming in DEV-3.
 */
export class TestTransaction {
  async begin(): Promise<void> {
    // placeholder
  }

  async rollback(): Promise<void> {
    // placeholder
  }
}
