// Lazy loader for Team DELIVERY modules, with test overrides.
// A broken DELIVERY file never stops the CLI from loading; calls into it fail with a clear error.

const NAMES = ['git', 'worktree', 'evidence', 'checks', 'integrate', 'gh', 'broker'];
let overrides = {};
const cache = {};

/** Tests: setDelivery({checks: {...}, integrate: {...}}). Pass {} to clear. */
export function setDelivery(obj) { overrides = obj || {}; }

function broken(name, err) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return () => { const e = new Error(`delivery module ${name}.mjs unavailable: ${err.message}`); e.code = 'DELIVERY_UNAVAILABLE'; throw e; };
    },
  });
}

export async function load(name) {
  if (!NAMES.includes(name)) throw new Error(`unknown delivery module ${name}`);
  if (overrides[name]) return overrides[name];
  if (cache[name]) return cache[name];
  try {
    cache[name] = await import(`./${name}.mjs`);
  } catch (e) {
    return broken(name, e);
  }
  return cache[name];
}

export async function delivery(names = NAMES) {
  const out = {};
  for (const n of names) out[n] = await load(n);
  return out;
}
