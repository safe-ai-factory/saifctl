/**
 * IndexerProfile — encapsulates all codebase-indexing concerns for a specific backend.
 *
 * Supported profiles: shotgun (opt-in via `--indexer shotgun`)
 *
 * Each profile is responsible for:
 *   1. `init`         — indexing the codebase (called by `saifctl init`)
 *   2. `getMastraTool` — producing a Mastra tool that agents can call
 *                        to query the index by natural language question.
 *
 * Environment variables required by each profile should be documented in the profile
 * file (not enforced programmatically here), following the same convention used by
 * agent profiles.
 */

import type { Tool } from '@mastra/core/tools';

/** Inputs for {@link IndexerProfile.init} (project dir + identifier). */
export interface IndexerInitOpts {
  /** Absolute path to the project directory (where indexing commands are run). */
  projectDir: string;
  /** Project name used to identify the index (e.g. package.json "name"). */
  projectName: string;
}

/** Inputs for {@link IndexerProfile.getMastraTool} (project dir + identifier). */
export interface IndexerGetToolOpts {
  /** Absolute path to the project directory. */
  projectDir: string;
  /** Project name — same value passed to init(). Used to locate the index. */
  projectName: string;
}

/** Encapsulates codebase-indexing concerns for a specific backend (id, init, getMastraTool). */
export interface IndexerProfile {
  /**
   * Profile identifier used in --indexer CLI flag.
   * One of the SUPPORTED_INDEXER_PROFILE_IDS.
   */
  id: SupportedIndexerProfileId;

  /** Human-readable display name (e.g. "Shotgun"). */
  displayName: string;

  /**
   * Initializes (or re-indexes) the codebase.
   * Called once during `saifctl init`.
   */
  init(opts: IndexerInitOpts): void | Promise<void>;

  /**
   * Returns a Mastra tool that agents can call to query the indexed codebase.
   * The tool's execute function closes over projectName so the agent never
   * needs to pass it explicitly.
   *
   * The returned tool MUST use the standardized id `queryCodebaseIndex` so that
   * agent prompts remain profile-agnostic.
   */
  getMastraTool(opts: IndexerGetToolOpts): Tool | Promise<Tool>;
}

/** Tuple of all indexer profile ids accepted by the `--indexer` CLI flag. */
export const SUPPORTED_INDEXER_PROFILE_IDS = ['shotgun'] as const;
/** Union of all valid indexer profile ids (derived from {@link SUPPORTED_INDEXER_PROFILE_IDS}). */
export type SupportedIndexerProfileId = (typeof SUPPORTED_INDEXER_PROFILE_IDS)[number];
