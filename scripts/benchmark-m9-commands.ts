import { performance } from "node:perf_hooks"
import { CORE_M9_COMMANDS } from "../src/orchestration/commands/definitions/core-commands"
import { CommandRegistry } from "../src/orchestration/commands/domain/command-registry"
import { validateCommandInput } from "../src/orchestration/commands/domain/command-validator"
import { commandRequestFingerprint } from "../src/orchestration/commands/domain/command-fingerprint"

const registry = new CommandRegistry()
for (const command of CORE_M9_COMMANDS) registry.register(command)
const input = { taskDescription: "benchmark command boundary" }
const measure = (name: string, fn: () => unknown, count = 1000) => {
  for (let i = 0; i < 100; i++) fn()
  const start = performance.now()
  for (let i = 0; i < count; i++) fn()
  const elapsed = performance.now() - start
  console.log(JSON.stringify({ name, iterations: count, totalMs: Number(elapsed.toFixed(3)), averageMs: Number((elapsed / count).toFixed(6)) }))
}
measure("registry-resolution", () => registry.resolve("fd-task"))
measure("input-validation", () => validateCommandInput(registry.resolve("task/start"), input))
measure("request-fingerprint", () => commandRequestFingerprint("task/start", 1, input))
measure("command-enumeration", () => registry.listCommands())
