/**
 * Docker resources provisioned for a run role (coding or staging), tracked for teardown and dashboards.
 */
export interface DockerLiveInfra {
  engine: 'docker';
  networkName: string;
  composeProjectName: string;
  /** Ephemeral staging image tags to remove on teardown. */
  stagingImages: string[];
  /** Container names to force-remove on teardown (staging, test-runner, coder, inspect, etc.). */
  containers: string[];
  /** Host project root — resolves {@link composeFile} and compose CLI working paths. */
  projectDir: string;
  /** Relative compose path from env config when a compose stack was started. */
  composeFile?: string;
}
