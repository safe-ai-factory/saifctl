import type { AgentProfile } from '../types.js';
import { cursorStdoutStrategy } from './logs.js';

export const cursorProfile: AgentProfile = {
  id: 'cursor',
  displayName: 'Cursor',
  stdoutStrategy: cursorStdoutStrategy,
};
