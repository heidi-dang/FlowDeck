import { StreamRepository } from './stream-repository';
import { SseBroker } from './sse-broker';
import { FlowDeckStreamEvent, createStreamEvent } from './stream-event';
import { validateStreamEvent } from './stream-event-schema';

export interface StreamEventInput extends Partial<FlowDeckStreamEvent> {
  type: any;
  runId: string;
}

export class StreamPublisher {
  constructor(private repository: StreamRepository, private broker: SseBroker) {}

  /**
   * Required publication flow:
   * 1. Normalize input
   * 2. Pre-validate non-sequence canonical fields
   * 3. Begin write transaction
   * 4. Allocate sequence
   * 5. Construct final canonical event
   * 6. Validate complete event
   * 7. Insert event
   * 8. Insert outbox
   * 9. Commit
   * 10. Broadcast
   */
  publish(input: StreamEventInput): FlowDeckStreamEvent {
    // 1. Normalize input
    const unsequencedEvent = createStreamEvent({ ...input, sequence: 1 } as any);

    // 2. Pre-validate non-sequence canonical fields
    const preValidation = validateStreamEvent(unsequencedEvent);
    if (!preValidation.success || !preValidation.data) {
      throw new Error(`Pre-persistence validation failed: ${preValidation.error || 'schema validation failed'}`);
    }

    // 3 - 9. Execute atomic transaction in repository (validates final event inside tx)
    const committedEvent = this.repository.persistEvent(
      unsequencedEvent.runId,
      input.sequence && input.sequence > 0 ? input.sequence : 0,
      unsequencedEvent.type,
      unsequencedEvent,
      new Date(unsequencedEvent.occurredAt).getTime()
    );

    // 10. Broadcast ONLY after successful persistence & transaction commit
    this.broker.broadcastInternal(committedEvent.runId, committedEvent);

    return committedEvent;
  }
}
