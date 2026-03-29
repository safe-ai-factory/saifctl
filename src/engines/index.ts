/**
 * Infra engines — infrastructure adaptors for SaifCTL environments.
 *
 * An engine manages the full lifecycle of an isolated SaifCTL run:
 *   setup()        → create isolated network + start background services
 *   startStaging() → build & boot the application under test
 *   runTests()     → run the black-box test suite and return results
 *   runAgent()     → spawn the AI coding agent
 *   startInspect() → idle coder container for `run inspect`
 *   teardown()     → stop and remove all resources
 *
 * Infra tracking:
 * Each Run carries also info on what infra has been provisioned for this Run
 * (e.g. containers, networks, etc).
 * Each step takes the current {@link LiveInfra} from the previous step and
 * returns an updated copy:
 *   setup()        → { infra } (network + compose stack, etc.)
 *   startStaging() → { stagingHandle, infra } (app container + images)
 *   runTests()     → { tests, infra } (test runner container removed before return)
 *   runAgent()     → { agent, infra }
 *   startInspect() → { session, infra }
 *   teardown({ runId, infra, projectDir }) → tear down exactly what `infra` lists
 *
 * Logging:
 * Logger callbacks are passed to each method to properly track
 * each container. See {@link Engine} for more details.
 */

import type {
  DockerEnvironment,
  NormalizedCodingEnvironment,
  NormalizedStagingEnvironment,
} from '../config/schema.js';
import { DockerEngine } from './docker/index.js';
import { LocalEngine } from './local/index.js';
import type { Engine } from './types.js';

export type { EngineLogEvent, EngineLogSource, EngineOnLog } from './logs.js';
export { defaultEngineLog } from './logs.js';

/**
 * Factory: returns the correct engine for the given environment config.
 *
 * `docker` (the default) creates a DockerEngine. When the config includes
 * a `file`, the Compose stack is started as part of setup(); otherwise only
 * the isolated bridge network and core containers are managed.
 */
export function createEngine(
  env: NormalizedStagingEnvironment | NormalizedCodingEnvironment,
): Engine {
  switch (env.engine) {
    case 'docker':
      return new DockerEngine(env as DockerEnvironment);
    case 'local':
      return new LocalEngine();
    case 'helm': {
      throw new Error(
        `[engine] Helm engine is not yet implemented. ` +
          `Remove environments.*.engine = "helm" from saifctl/config.ts or implement HelmEngine.`,
      );
    }
    default: {
      const exhaustive: never = env;
      throw new Error(`[engine] Unknown engine: ${JSON.stringify(exhaustive)}`);
    }
  }
}
