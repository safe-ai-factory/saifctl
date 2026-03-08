import { z } from 'zod';

export const TestCaseSchema = z.object({
  id: z.string().describe('Unique test case ID (e.g. tc-greeting-001)'),
  title: z.string().describe('Short human-readable title'),
  description: z.string().describe('Longer description of what is being tested'),
  tracesTo: z.array(z.string()).describe('References to spec/plan sections this test traces to'),
  category: z
    .enum(['happy_path', 'boundary', 'negative', 'error_handling'])
    .describe('Test category'),
  visibility: z
    .enum(['public', 'hidden'])
    .describe('public = visible to coder; hidden = holdout for mutual verification'),
  /**
   * Relative path to the .spec.ts file (from tests/) implementing this test case.
   *
   * Example: "public/greet-happy.spec.ts"
   */
  entrypoint: z.string().optional().describe('Relative path to the .spec.ts file from tests/'),
});

export type TestCase = z.infer<typeof TestCaseSchema>;

/**
 * Docker build configuration for the staging container.
 *
 * The orchestrator builds a runtime-only image (e.g. node, pnpm); code is
 * mounted at container start. startup.sh (same as coder) installs deps at
 * runtime.
 *
 * - `dockerfile` omitted or `undefined`: use the sandbox profile's `Dockerfile.stage`
 *   (e.g. node-pnpm-python profile: node + pnpm + Python; no code in image).
 * - `dockerfile: "path/to/Dockerfile"`: use a custom Dockerfile relative to
 *   the repo root for non-Node sandboxes.
 */
const StagingContainerBuildSchema = z.object({
  /**
   * Path to a custom Dockerfile relative to the repo root.
   * When omitted the orchestrator uses the sandbox profile's `Dockerfile.stage`.
   */
  dockerfile: z
    .string()
    .optional()
    .describe('Custom Dockerfile path (repo-root-relative), or omit for profile Dockerfile.stage'),
});

/**
 * Staging container schema.
 *
 * Every staging container runs both the sidecar (for command execution) and the
 * application server. The sidecar is always available at sidecarPort/sidecarPath;
 * the web app (if any) is available at baseUrl.
 *
 * - sidecarPort / sidecarPath: always present; default to 8080 / /exec.
 * - baseUrl: the URL of the web application inside the container. Omit for
 *   pure CLI projects where the sidecar is the only HTTP surface.
 */
const StagingContainerSchema = z.object({
  sidecarPort: z.number().default(8080),
  sidecarPath: z.string().default('/exec'),
  /**
   * Base URL of the web application served by the staging container.
   *
   * Use "staging" as the hostname — the staging container is always reachable
   * by that alias inside the Docker bridge network (e.g. "http://staging:3000").
   *
   * Leave unset for pure CLI projects where the sidecar is the only HTTP surface.
   */
  baseUrl: z.string().optional(),
  build: StagingContainerBuildSchema.optional(),
});

const AdditionalContainerSchema = z.object({
  name: z
    .string()
    .describe('Container name (used as hostname for other containers; e.g. postgres, redis)'),
  image: z.string().describe('Docker image'),
});

export const TestCatalogSchema = z.object({
  version: z.string().default('1.0'),
  changeName: z.string().describe('Name of the change/feature (matches openspec/changes/<name>)'),
  specDir: z.string().describe('Path to spec directory relative to repo root'),
  containers: z.object({
    staging: StagingContainerSchema,
    additional: z.array(AdditionalContainerSchema).default([]),
  }),
  testCases: z.array(TestCaseSchema),
});

export type TestCatalog = z.infer<typeof TestCatalogSchema>;
