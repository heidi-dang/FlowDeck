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
   * Single canonical persist-before-deliver publication operation:
   * 1. Allocate sequence and persist event & outbox record atomically in SQLite
   * 2. Validate canonical event schema
   * 3. Commit transaction
   * 4. Broadcast committed event to live subscribers
   */
  publish(input: StreamEventInput): FlowDeckStreamEvent {
    // Determine target sequence from repository or input
    const targetSeq = input.sequence && input.sequence > 0 ? input.sequence : 1;
    const rawEvent = createStreamEvent({ ...input, sequence: targetSeq } as any);

    // Atomically persist event & outbox record in SQLite (allocates true aggregate version if 1)
    const allocatedSequence = this.repository.persistEvent(
      rawEvent.runId,
      rawEvent.sequence,
      rawEvent.type,
      rawEvent,
      Date.now()
    );

    const committedEvent: FlowDeckStreamEvent = {
      ...rawEvent,
      sequence: allocatedSequence,
    };

    const validation = validateStreamEvent(committedEvent);
    if (!validation.success || !validation.data) {
      throw new Error(`Invalid stream event: ${validation.error || 'schema validation failed'}`);
    }

    // Broadcast ONLY after successful persistence & transaction commit
    this.broker.broadcastInternal(committedEvent.runId, validation.data);

    return validation.data;
  }
}
