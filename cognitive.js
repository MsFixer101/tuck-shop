// cognitive.js — Bridge: Train Tracks cognitive tools → Tuck Shop CAPABILITIES.
//
// Phase 1 of the Eve runtime/training standardisation. The calculator,
// datetime, probability, statistics, thesaurus and units toolkits that models
// see at TRAINING time (inside Train Tracks) must also exist at RUNTIME (via
// Tuck Shop). The Train Tracks tools package stays the single source of truth —
// we import its executors and definitions by path, we never copy them here.
//
// If the Train Tracks package is missing, `cognitiveCapabilities` is `{}` and a
// clear warning is logged. Tuck Shop then still boots with its original 6 tools
// — a degraded shelf beats a dead service.

import { createRequire } from 'node:module';

const TT_TOOLS_PATH =
  process.env.TT_TOOLS_PATH ||
  '/Users/christina/panel-of-experts/training-tools/train-tracks/tools/index.js';

// Turn a JSON-Schema property type + required-ness into the tuck-shop hint
// convention: bare type name when required, `type?` when optional.
function toArgHint(schemaType, required) {
  const t = schemaType || 'string';
  return required ? t : `${t}?`;
}

// Wrap a Train Tracks executor into a CAPABILITIES handler.
// Contract: return `{ result }` on success, `{ error: <message> }` on a thrown
// error or an executor-returned `{ error }` shape.
function makeHandler(executor) {
  return async (args = {}) => {
    try {
      const out = await executor(args || {});
      if (out && typeof out === 'object' && 'error' in out && out.error) {
        return { error: typeof out.error === 'string' ? out.error : JSON.stringify(out.error) };
      }
      return { result: out };
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  };
}

function buildCognitiveCapabilities() {
  let cognitive;
  try {
    const require = createRequire(import.meta.url);
    cognitive = require(TT_TOOLS_PATH);
  } catch (err) {
    console.warn(
      `[tuck-shop] cognitive tools unavailable at ${TT_TOOLS_PATH} (${err.message}); booting with core tools only`
    );
    return {};
  }

  const { ALL_EXECUTORS, buildProviderDefs } = cognitive;
  if (!ALL_EXECUTORS || typeof buildProviderDefs !== 'function') {
    console.warn(
      '[tuck-shop] cognitive tools package loaded but missing expected exports (ALL_EXECUTORS / buildProviderDefs); skipping'
    );
    return {};
  }

  // buildProviderDefs('anthropic') yields [{ name, description, input_schema }],
  // where input_schema is the JSON Schema built from the same TOOL_DEFS the
  // executors were declared with. It is our single deterministic source for
  // description, arg hints, and the machine-readable schema.
  let defs;
  try {
    defs = buildProviderDefs('anthropic');
  } catch (err) {
    console.warn(`[tuck-shop] failed to build cognitive tool defs (${err.message}); skipping`);
    return {};
  }

  const caps = {};
  for (const def of defs) {
    const { name, description, input_schema: schema } = def;
    const executor = ALL_EXECUTORS[name];
    if (!executor) continue; // definition with no matching executor — skip defensively

    const required = new Set(schema && Array.isArray(schema.required) ? schema.required : []);
    const args = {};
    for (const [prop, meta] of Object.entries((schema && schema.properties) || {})) {
      args[prop] = toArgHint(meta && meta.type, required.has(prop));
    }

    caps[name] = {
      description,
      args,
      schema, // JSON Schema — surfaced additively by GET /tools
      handler: makeHandler(executor),
    };
  }

  return caps;
}

export const cognitiveCapabilities = buildCognitiveCapabilities();
