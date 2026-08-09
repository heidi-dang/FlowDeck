import type { CommandDefinition } from "./command-definition";

export class CommandRegistryError extends Error {
  constructor(
    public readonly code: "DUPLICATE_ID" | "ALIAS_COLLISION" | "NOT_FOUND" | "INVALID_DEFINITION",
    message: string,
  ) {
    super(message);
    this.name = "CommandRegistryError";
  }
}

export class CommandRegistry {
  private readonly definitionsById = new Map<string, Map<number, CommandDefinition>>();
  private readonly aliasToIdMap = new Map<string, string>();

  /**
   * Register a typed CommandDefinition.
   * Fails closed if duplicate ID+version or if alias collides with a different command ID.
   */
  register(definition: CommandDefinition): void {
    if (!definition || !definition.id || typeof definition.version !== "number") {
      throw new CommandRegistryError("INVALID_DEFINITION", "Command definition must have id and version");
    }

    const { id, version, aliases = [] } = definition;

    // Check alias collisions
    for (const alias of [id, ...aliases]) {
      const existingId = this.aliasToIdMap.get(alias);
      if (existingId && existingId !== id) {
        throw new CommandRegistryError(
          "ALIAS_COLLISION",
          `Alias or ID '${alias}' for command '${id}' collides with existing registered command '${existingId}'`,
        );
      }
    }

    let versionMap = this.definitionsById.get(id);
    if (!versionMap) {
      versionMap = new Map<number, CommandDefinition>();
      this.definitionsById.set(id, versionMap);
    }

    if (versionMap.has(version)) {
      throw new CommandRegistryError(
        "DUPLICATE_ID",
        `Command '${id}' version ${version} is already registered`,
      );
    }

    versionMap.set(version, definition);
    this.aliasToIdMap.set(id, id);
    for (const alias of aliases) {
      this.aliasToIdMap.set(alias, id);
    }
  }

  /**
   * Resolve a command definition by ID or alias, with optional explicit version.
   * If version is omitted, returns the latest version deterministically.
   */
  resolve(idOrAlias: string, version?: number): CommandDefinition {
    const canonicalId = this.aliasToIdMap.get(idOrAlias);
    if (!canonicalId) {
      throw new CommandRegistryError("NOT_FOUND", `Command or alias '${idOrAlias}' not found in registry`);
    }

    const versionMap = this.definitionsById.get(canonicalId);
    if (!versionMap || versionMap.size === 0) {
      throw new CommandRegistryError("NOT_FOUND", `No versions registered for command '${canonicalId}'`);
    }

    if (typeof version === "number") {
      const def = versionMap.get(version);
      if (!def) {
        throw new CommandRegistryError("NOT_FOUND", `Command '${canonicalId}' version ${version} not found`);
      }
      return def;
    }

    // Latest version (highest numeric version)
    const sortedVersions = Array.from(versionMap.keys()).sort((a, b) => b - a);
    return versionMap.get(sortedVersions[0])!;
  }

  /**
   * Enumerate all registered commands sorted deterministically by command ID.
   */
  listCommands(): CommandDefinition[] {
    const sortedIds = Array.from(this.definitionsById.keys()).sort();
    const results: CommandDefinition[] = [];

    for (const id of sortedIds) {
      const versionMap = this.definitionsById.get(id)!;
      const sortedVersions = Array.from(versionMap.keys()).sort((a, b) => b - a);
      results.push(versionMap.get(sortedVersions[0])!);
    }

    return results;
  }

  /**
   * Clear all registrations (for testing).
   */
  clear(): void {
    this.definitionsById.clear();
    this.aliasToIdMap.clear();
  }
}
