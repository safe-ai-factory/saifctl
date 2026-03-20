import { readUtf8, spawnCapture } from '../../utils/io.js';

export default async function validateDescriptiveTests() {
  const output = await spawnCapture({
    command: 'git',
    args: ['ls-files', 'src/**/*.test.ts', 'saifac/**/*.test.ts'],
    cwd: process.cwd(),
  });
  const files = output.split('\n').filter((f) => f.trim() !== '');

  let failed = false;
  // Matches it('description', ...) or test("description", ...)
  const testRegex = /(?:it|test)\s*\(\s*(['"`])(.*?)\1\s*,/g;

  for (const file of files) {
    const content = await readUtf8(file);
    let match;

    while ((match = testRegex.exec(content)) !== null) {
      const description = match[2].trim();

      // Heuristics for a bad description:
      // 1. Fewer than 3 words and under 15 characters
      // 2. Exactly matches generic strings
      const wordCount = description.split(/\s+/).length;
      const isTooShort = description.length < 15 && wordCount < 3;
      const isGeneric = /^(works|test|passes|should pass|should work|basic test)$/i.test(
        description,
      );

      if (isTooShort || isGeneric) {
        console.error(`❌ Non-descriptive test name in ${file}: "${description}"`);
        console.error(`   Hint: Explain WHAT is being tested and WHAT the expected outcome is.`);
        failed = true;
      }
    }
  }

  if (failed) {
    throw new Error('One or more tests have non-descriptive names.');
  }
}
