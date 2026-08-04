import { RunProjectionState } from '../../orchestration/streaming/projection';
    export interface UIProps {
      state: RunProjectionState;
      onCancel?: () => void;
      onApprove?: (id: string) => void;
      onReject?: (id: string) => void;
    }