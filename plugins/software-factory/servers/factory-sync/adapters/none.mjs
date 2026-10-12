// Adapter "none": every method is a no-op and makes no network call.

export function createNone() {
  return {
    name: 'none',
    capabilities() {
      return { statusModel: 'open_closed', goalModels: [], deltaPull: 'since', comments: false, links: 'body_ref', subIssues: false, maxWritesPerTick: 0 };
    },
    async discover() { return { viewer: { id: null, handle: null }, scopes: [], states: [], labels: [], fields: {} }; },
    async pull({ cursor } = {}) { return { items: [], comments: [], missing: [], nextCursor: cursor || null }; },
    async push(ops = []) { return ops.map((op) => ({ opId: op.opId, ok: false, error: 'tracker provider is none' })); },
    async findByLocalId() { return null; },
  };
}
