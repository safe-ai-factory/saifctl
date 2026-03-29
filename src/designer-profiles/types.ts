/**
 * DesignerProfile — encapsulates the "spec generation" step of the feature workflow.
 *
 * Supported profiles: shotgun (default)
 *
 * Each profile is responsible for:
 *   1. `hasRun`  — detecting whether the design step has already been completed
 *                  for a given feature directory (used to prompt "Redo?")
 *   2. `run`     — executing the design phase: reading the proposal + any existing
 *                  files in <feat>, querying the codebase if needed, and writing
 *                  the output files to saifctl/features/<feat>/
 *
 * Contract:
 *   Input  (read from disk by the profile):
 *     - saifctl/features/<feat>/proposal.md      (optional, but strongly recommended)
 *     - any other existing files under <feat>/   (research, notes, etc.)
 *   Output (written to disk by the profile):
 *     - saifctl/features/<feat>/plan.md          (REQUIRED — consumed by downstream agents)
 *     - saifctl/features/<feat>/specification.md (REQUIRED — consumed by tests design)
 *     - saifctl/features/<feat>/<others>         (optional, e.g. research.md, tasks.md)
 *
 * Environment variables required by each profile should be documented in the profile
 * file (not enforced programmatically here), following the same convention used by
 * indexer profiles.
 */

import type { Tool } from '@mastra/core/tools';

import type { Feature } from '../specs/discover.js';

export interface DesignerBaseOpts {
  /** Absolute path to the repo root. */
  cwd: string;
  /** Resolved feature (name, absolutePath, relativePath). */
  feature: Feature;
  /** Saifctl directory name relative to repo root (e.g. "saifctl"). */
  saifctlDir: string;
}

export interface DesignerRunOpts extends DesignerBaseOpts {
  /**
   * LLM model identifier to use (e.g. "claude-3-5-sonnet-20241022").
   * Profiles may ignore this if they manage model selection internally.
   */
  model?: string;

  /**
   * User-supplied prompt / proposal text. If not provided, the profile
   * should read proposal.md from the feature directory.
   */
  prompt?: string;

  /**
   * A Mastra tool for querying the indexed codebase, produced by the active
   * IndexerProfile. When provided, the designer can use it to ground spec
   * generation in real code structure.
   * When undefined, the designer runs without codebase search capability.
   */
  indexerTool?: Tool;
}

export interface DesignerProfile {
  /**
   * Profile identifier used in the --designer CLI flag.
   * One of the SUPPORTED_DESIGNER_PROFILE_IDS.
   */
  id: SupportedDesignerProfileId;

  /** Human-readable display name (e.g. "Shotgun"). */
  displayName: string;

  /**
   * Returns true if this designer has already run for the given feature
   * (i.e. its expected output files are present on disk).
   * Used by the CLI to prompt "Output present. Redo?".
   */
  hasRun(opts: DesignerBaseOpts): boolean | Promise<boolean>;

  /**
   * Executes the design phase for the feature.
   * Reads proposal.md (and any other relevant files) from the feature directory,
   * then writes the required output files (plan.md, specification.md, …).
   */
  run(opts: DesignerRunOpts): void | Promise<void>;
}

export const SUPPORTED_DESIGNER_PROFILE_IDS = ['shotgun'] as const;
export type SupportedDesignerProfileId = (typeof SUPPORTED_DESIGNER_PROFILE_IDS)[number];
