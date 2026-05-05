import type { LiveInfra } from '../../engines/types.js';
import type { RunCommit } from '../../runs/types.js';
import type { SubtaskCodingResult } from './subtask-driver-types.js';

export type {
  OnSubtaskComplete,
  SubtaskCodingResult,
  SubtaskDriverAction,
} from './subtask-driver-types.js';

/** Return shape of `runCodingPhase` (iterative loop coding round). */
export type CodingPhaseResult =
  | {
      outcome: 'completed';
      infra: LiveInfra;
      /** One entry per subtask inner loop that completed while the container was alive. */
      subtaskResults: SubtaskCodingResult[];
    }
  | { outcome: 'paused'; liveInfra: LiveInfra | null; commits: RunCommit[] }
  | { outcome: 'stopped'; commits: RunCommit[] }
  | { outcome: 'inspected' };
