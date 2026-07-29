import { randomUUID } from "crypto";
import { OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IAuthorizationService, IIdempotencyStore, IEventBus } from "./ports";
import type { RunService } from "./run-service";
import type { ContractService } from "./contract-service";
import type { AssignmentService } from "./assignment-service";
import type { VerificationService } from "./verification-service";
import type { CompletionService } from "./completion-service";
import type { ReplayService } from "./replay-service";
import type { EventService } from "./event-service";

// ── Command types ─────────────────────────────────────────────────────────

export interface Command {
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  auth?: { userId?: string; roles?: string[] };
}

export interface CommandResponse {
  success: boolean;
  commandId: string;
  correlationId: string;
  causationId?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

// ── Command handler ───────────────────────────────────────────────────────

type CommandHandler = (command: Command) => Promise<Record<string, unknown>>;

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  constructor(
    private readonly authService: IAuthorizationService,
    private readonly idempotencyStore: IIdempotencyStore,
    private readonly eventBus: IEventBus,
  ) {}

  registerService(typePrefix: string, service: Record<string, unknown>): void {
    // Services register their command handlers
  }

  registerHandler(commandType: string, handler: CommandHandler): void {
    this.handlers.set(commandType, handler);
  }

  async dispatch(command: Command): Promise<CommandResponse> {
    const commandId = randomUUID();
    const correlationId = command.correlationId ?? randomUUID();

    // Idempotency check
    if (command.idempotencyKey) {
      const duplicate = await this.idempotencyStore.isDuplicate(command.idempotencyKey);
      if (duplicate) {
        const existing = await this.idempotencyStore.getResult(command.idempotencyKey);
        return {
          success: true,
          commandId,
          correlationId,
          causationId: command.causationId,
          result: existing ?? undefined,
        };
      }
    }

    // Auth check
    if (command.auth) {
      const authResult = await this.authService.authorize(
        command.type,
        "orchestration",
        { userId: command.auth.userId, roles: command.auth.roles },
      );
      if (!authResult.allowed) {
        await this.publishCommandEvent(commandId, command, correlationId, OrchestrationEventType.COMMAND_FAILED);
        return {
          success: false,
          commandId,
          correlationId,
          error: { code: ErrorCodes.FORBIDDEN.code, message: authResult.reason ?? "Forbidden", retryable: false },
        };
      }
    }

    // Validate handler exists
    const handler = this.handlers.get(command.type);
    if (!handler) {
      return {
        success: false,
        commandId,
        correlationId,
        error: { code: ErrorCodes.INVALID_INPUT.code, message: `Unknown command type: ${command.type}`, retryable: false },
      };
    }

    // Dispatch
    await this.publishCommandEvent(commandId, command, correlationId, OrchestrationEventType.COMMAND_DISPATCHED);
    try {
      const result = await handler(command);

      // Mark idempotency
      if (command.idempotencyKey) {
        await this.idempotencyStore.markProcessed(command.idempotencyKey);
      }

      await this.publishCommandEvent(commandId, command, correlationId, OrchestrationEventType.COMMAND_COMPLETED);
      return { success: true, commandId, correlationId, causationId: command.causationId, result };
    } catch (error) {
      const orchestrationError = error instanceof OrchestrationError ? error
        : OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR, { message: String(error) });

      await this.publishCommandEvent(commandId, command, correlationId, OrchestrationEventType.COMMAND_FAILED);
      return {
        success: false,
        commandId,
        correlationId,
        error: { code: orchestrationError.code, message: orchestrationError.message, retryable: orchestrationError.retryable },
      };
    }
  }

  private async publishCommandEvent(
    commandId: string, command: Command, correlationId: string, eventType: string,
  ): Promise<void> {
    await this.eventBus.publish({
      id: randomUUID(),
      type: eventType as any,
      timestamp: new Date().toISOString(),
      correlationId,
      causationId: command.causationId,
      data: { commandId, commandType: command.type },
      metadata: {},
    });
  }
}
