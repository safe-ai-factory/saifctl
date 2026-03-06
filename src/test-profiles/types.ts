/** Options passed to a profile's onDone hook after spec file generation. */
export interface OnDoneOpts {
  testsDir: string;
  generatedFiles: string[];
  force: boolean;
}

export interface TestProfile {
  /**
   * Profile identifier used in CLI flags and tests.json.
   * One of the SUPPORTED_PROFILE_IDS.
   */
  id: SupportedProfileId;

  /** Human-readable language name (used in agent prompts). */
  language: string;

  /** Test framework name (used in agent prompts). */
  framework: string;

  /** File extension for spec files, including the dot (e.g. ".spec.ts", ".py", "_test.go"). */
  specExtension: string;

  /**
   * Naming convention for spec files, as a prompt-facing rule string.
   * Injected verbatim into the catalog agent prompt.
   */
  fileNamingRule: string;

  /**
   * Filename (no directory) of the helpers template inside
   * src/blackbox/templates/<id>/.
   */
  helpersFilename: string;

  /**
   * Filename (no directory) of the infra health-check template inside
   * src/blackbox/templates/<id>/.
   * null means no infra spec file is used for this profile.
   */
  infraFilename: string | null;

  /**
   * Import or module-header lines the coder agent must include at the top of every spec file.
   * Injected verbatim into the coder agent prompt.
   */
  importRules: string;

  /**
   * Framework-specific assertion rules injected into the coder agent prompt.
   */
  assertionRules: string;

  /**
   * Optional hook called by generateSpecTestScaffold after all spec files are generated.
   * Use for profile-specific post-processing (e.g. Rust mod.rs generation).
   */
  onDone?: (opts: OnDoneOpts) => void | Promise<void>;

  /**
   * Optional hook called by feat:design and feat:test-gen after spec file generation.
   * Use for profile-specific validation (e.g. tsc for TypeScript).
   */
  validateFiles?: (opts: ValidateFilesOpts) => void | Promise<void>;
}

/** Options passed to a profile's validateFiles hook. */
export interface ValidateFilesOpts {
  testsDir: string;
  generatedFiles: string[];
  projectDir: string;
  errMessage: string;
}

export const SUPPORTED_PROFILE_IDS = [
  'ts-vitest',
  'ts-playwright',
  'py-pytest',
  'py-playwright',
  'go-gotest',
  'go-playwright',
  'rs-rusttest',
  'rs-playwright',
] as const;
export type SupportedProfileId = (typeof SUPPORTED_PROFILE_IDS)[number];
