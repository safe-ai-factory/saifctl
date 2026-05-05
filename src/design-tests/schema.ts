import { z } from 'zod';

/** Zod schema for a single planned test case (id, category, visibility, traceability, optional entrypoint). */
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

/** Inferred type for a single test case (see {@link TestCaseSchema}). */
export type TestCase = z.infer<typeof TestCaseSchema>;

/** Zod schema for the persisted tests.json catalog: feature metadata + an array of {@link TestCaseSchema}. */
export const TestCatalogSchema = z.object({
  version: z.string().default('1.0'),
  featureName: z.string().describe('Name of the feature (matches saifctl/features/<name>)'),
  featureDir: z
    .string()
    .describe(
      'Path to feature directory relative to project root (e.g. "saifctl/features/<featureName>")',
    ),
  testCases: z.array(TestCaseSchema),
});

/** Inferred type for the tests.json catalog (see {@link TestCatalogSchema}). */
export type TestCatalog = z.infer<typeof TestCatalogSchema>;
