export interface TemporalOptions {
  /** History table name (default: entityTable + "_history"). */
  historyTable?: string;
  /** Enable bi-temporal support (valid time + transaction time). Default: false. */
  bitemporal?: boolean;
  /** Valid-from column name. Default: "valid_from". */
  validFromColumn?: string;
  /** Valid-to column name. Default: "valid_to". */
  validToColumn?: string;
  /** Transaction-from column name (bi-temporal only). Default: "transaction_from". */
  transactionFromColumn?: string;
  /** Transaction-to column name (bi-temporal only). Default: "transaction_to". */
  transactionToColumn?: string;
}

interface ResolvedTemporalMetadata {
  historyTable: string;
  bitemporal: boolean;
  validFromColumn: string;
  validToColumn: string;
  transactionFromColumn: string;
  transactionToColumn: string;
}

const temporalMetadata = new WeakMap<object, ResolvedTemporalMetadata>();

export function Temporal(options?: TemporalOptions) {
  return function <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass {
    const resolved: ResolvedTemporalMetadata = {
      historyTable: options?.historyTable ?? "",
      bitemporal: options?.bitemporal ?? false,
      validFromColumn: options?.validFromColumn ?? "valid_from",
      validToColumn: options?.validToColumn ?? "valid_to",
      transactionFromColumn: options?.transactionFromColumn ?? "transaction_from",
      transactionToColumn: options?.transactionToColumn ?? "transaction_to",
    };

    temporalMetadata.set(target, resolved);
    return target;
  };
}

export function getTemporalMetadata(target: object): ResolvedTemporalMetadata | undefined {
  const entry = temporalMetadata.get(target);
  return entry ? { ...entry } : undefined;
}

export function isTemporalEntity(target: object): boolean {
  return temporalMetadata.has(target);
}
