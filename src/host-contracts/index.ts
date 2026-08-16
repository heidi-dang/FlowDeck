/**
 * FlowDeck host-neutral contracts.
 *
 * These interfaces define exactly what FlowDeck's portable core needs from
 * any execution host (OpenCode, DSH, future hosts). They are deliberately
 * minimal — only model what FlowDeck actually requires, not the full host API.
 *
 * Architecture invariants:
 *   - No OpenCode SDK types imported here.
 *   - No DSH/Cordis types imported here.
 *   - No bun:sqlite or node:sqlite types imported here.
 *   - No conversation content owned by FlowDeck (that belongs to the host).
 *
 * Phase 2: establishes clean boundary types.
 * Phase 3: OpenCode adapter implements these.
 * Phase 7/8: DSH adapter implements these.
 */

export type { FlowDbAdapter, FlowStmt } from '../orchestration/persistence/db-adapter.ts'
export type { ModelLock } from './model-lock.ts'
export type { ChildSessionRef } from './child-session.ts'
export type { HostToolDefinition, ToolExecuteContext } from './tool-definition.ts'
