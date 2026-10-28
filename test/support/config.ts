// A complete test configuration, loaded through the real schema
// (src/config/schema.ts) from the test deployment's variables
// (test/support/variables.ts, which also feeds the workers tier).
import { loadConfig, type Config } from '../../src/config/schema';
import { TEST_VARIABLES } from './variables';

export { IDS, TEST_VARIABLES } from './variables';

/** The test configuration, with `overrides` applied (an undefined value removes a variable). */
export const testConfig = (overrides: Readonly<Record<string, string | undefined>> = {}): Config =>
  loadConfig({ ...TEST_VARIABLES, ...overrides });
