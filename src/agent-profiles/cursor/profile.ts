import type { AgentProfile } from '../types.js';
import { cursorStdoutStrategy } from './logs.js';

/** Agent profile for the Cursor agent CLI; uses a structured stdout strategy. */
export const cursorProfile: AgentProfile = {
  id: 'cursor',
  displayName: 'Cursor',
  stdoutStrategy: cursorStdoutStrategy,
};
