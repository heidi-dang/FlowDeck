export interface TransactionEdit {
  path: string[];
  value: any;
}

export interface TransactionOptions {
  configPath: string;
  edits?: TransactionEdit[];
  manifest?: Record<string, any>;
  manifestPath: string;
  allowCorruptManifest?: boolean;
  skipManifest?: boolean;
  deleteManifest?: boolean;
}

export interface TransactionResult {
  ok: boolean;
  backupPath?: string;
  error?: string;
}

export interface RollbackOptions {
  configPath: string;
  manifestPath: string;
  backupPath: string;
}

export function executeTransaction(options: TransactionOptions): Promise<TransactionResult>;
export function executeRollbackTransaction(options: RollbackOptions): Promise<TransactionResult>;
