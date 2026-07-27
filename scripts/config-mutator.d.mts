export function safeParseConfig(content: string): { ok: boolean; data?: any; error?: string };
export function readConfig(filePath: string): { existing: any; parseError?: string };
export function applyJsoncEdits(rawContent: string, edits: any[]): string;
export function createBackup(filePath: string): string | null;
export function atomicWrite(filePath: string, content: string): void;
export function writeConfig(filePath: string, rawContent: string, edits: any[]): { ok: boolean; error?: string };
