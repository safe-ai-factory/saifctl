import type { AgentProfile } from '../types.js';
import { openhandsStdoutStrategy } from './logs.js';

/** Agent profile for the OpenHands CLI; uses a structured stdout strategy. */
export const openhandsProfile: AgentProfile = {
  id: 'openhands',
  displayName: 'OpenHands',
  stdoutStrategy: openhandsStdoutStrategy,
};
