import type { CommandInvocation } from "../domain/command-definition";

export class CommandSecurityException extends Error {
  constructor(message: string, public readonly code: "PATH_TRAVERSAL" | "SHELL_INJECTION" | "OWNERSHIP_BYPASS" | "BUDGET_BYPASS" | "VERIFICATION_BYPASS") {
    super(`Command Security Violation: ${message}`);
    this.name = "CommandSecurityException";
  }
}

/**
 * Validates command inputs against security policies before compilation.
 */
export function enforceCommandSecurity(invocation: CommandInvocation): void {
  const inputStr = JSON.stringify(invocation.input);
  
  // 1. Path Traversal & Symlink Escapes
  if (inputStr.includes("../") || inputStr.includes("..\\") || inputStr.match(/(^|[\\/])\.\.($|[\\/])/)) {
    throw new CommandSecurityException("Path traversal attempt detected", "PATH_TRAVERSAL");
  }

  // 2. Shell Metacharacters (we disallow shell characters in common inputs)
  // Check typical shell injection vectors if any value contains them.
  // We'll inspect string values recursively.
  const hasShellChars = checkValuesForRegex(invocation.input, /[;|&$><`\\\n\r]/);
  if (hasShellChars) {
    throw new CommandSecurityException("Shell metacharacters detected in input", "SHELL_INJECTION");
  }

  // 3. Ownership / Validation Bypasses
  // Ensure we aren't allowing direct mutation of system tokens if we expect a safe payload
  const hasBypassKeys = checkKeysForRegex(invocation.input, /bypass|forceCompletion|skipVerification|skipCompletion|ignoreBudget|unapprovedTool|strategyOverride/i);
  if (hasBypassKeys) {
    throw new CommandSecurityException("Attempt to bypass verification or completion gates", "VERIFICATION_BYPASS");
  }
}

function checkValuesForRegex(obj: unknown, regex: RegExp): boolean {
  if (typeof obj === "string") {
    return regex.test(obj);
  }
  if (Array.isArray(obj)) {
    return obj.some(val => checkValuesForRegex(val, regex));
  }
  if (obj && typeof obj === "object") {
    return Object.entries(obj).some(([key, val]) => regex.test(key) || checkValuesForRegex(val, regex));
  }
  return false;
}

function checkKeysForRegex(obj: unknown, regex: RegExp): boolean {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      if (regex.test(key) || checkKeysForRegex(value, regex)) {
        return true;
      }
    }
  }
  return false;
}
