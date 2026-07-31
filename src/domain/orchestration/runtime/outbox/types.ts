import { RuntimeEventType } from "../event-store/types";

export interface RuntimeEvent<TPayload = unknown> {
  readonly id: string;
  readonly type: RuntimeEventType;
  readonly data: TPayload;
  readonly timestamp: Date;
}
