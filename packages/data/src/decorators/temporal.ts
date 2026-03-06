const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateTemporalIdentifier(value: string, name: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(`Invalid ${name}: "${value}". Must be a valid SQL identifier.`);
  }
}

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
  return <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass => {
    const historyTable = options?.historyTable ?? "";
    const validFromColumn = options?.validFromColumn ?? "valid_from";
    const validToColumn = options?.validToColumn ?? "valid_to";
    const transactionFromColumn = options?.transactionFromColumn ?? "transaction_from";
    const transactionToColumn = options?.transactionToColumn ?? "transaction_to";

    // Validate all identifier options
    if (historyTable) validateTemporalIdentifier(historyTable, "historyTable");
    validateTemporalIdentifier(validFromColumn, "validFromColumn");
    validateTemporalIdentifier(validToColumn, "validToColumn");
    if (options?.bitemporal) {
      validateTemporalIdentifier(transactionFromColumn, "transactionFromColumn");
      validateTemporalIdentifier(transactionToColumn, "transactionToColumn");
    }

    const resolved: ResolvedTemporalMetadata = {
      historyTable,
      bitemporal: options?.bitemporal ?? false,
      validFromColumn,
      validToColumn,
      transactionFromColumn,
      transactionToColumn,
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
