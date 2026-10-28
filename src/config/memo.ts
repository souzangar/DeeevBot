// @critical-path
// The per-isolate configuration memo (critical invariants 2 and 6; the MVP
// plan's "the parsed configuration is memoised per isolate"). The Worker's
// `env` carries the bindings (D1, the broadcaster's namespace) beside the
// variables and secrets; configFor(env) passes only its string-valued
// properties to loadConfig() and keeps the result for as long as that same
// `env` object is alive, so an isolate parses its configuration once per
// `env` object instead of once per update.
//
// The memo is keyed by object identity in a WeakMap: a different `env`
// object is parsed afresh, a mutation of a memoised `env` is not seen, and
// nothing is kept once the runtime drops the object. A failed load is not
// memoised: every call on an invalid `env` throws the AppError
// CONFIG_INVALID again. Non-string values are ignored, which includes JSON
// `vars` from wrangler.jsonc: this deployment keeps `vars` empty and sets
// every value as a secret, and a secret is always a string.
import { loadConfig, type Config } from './schema';

const memo = new WeakMap<object, Config>();

/** The string-valued properties of `env`: its variables and secrets, never its bindings. */
const stringVariables = (env: object): Record<string, string> => {
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(env as Readonly<Record<string, unknown>>)) {
    if (typeof value === 'string') variables[name] = value;
  }
  return variables;
};

/**
 * The validated configuration for this `env`, parsed on the first call for
 * it. Throws as loadConfig() does.
 */
export function configFor(env: object): Config {
  const memoised = memo.get(env);
  if (memoised !== undefined) return memoised;
  const config = loadConfig(stringVariables(env));
  memo.set(env, config);
  return config;
}
