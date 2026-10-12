// Polls `.factory/` every 1.5 s (index, budget, factory state, gates, inbox, usage and the
// events byte offset) and pushes changes to SSE clients. Polling, not fs.watch: it behaves the
// same on Windows, network drives, WSL and Docker mounts, and costs a few stat calls per cycle.
export const POLL_MS = 1500;

export function startPoller({ state, hub, intervalMs = POLL_MS, onCycle = () => {}, log = () => {} }) {
  let busy = false;
  let errors = 0;
  const cycle = () => {
    if (busy) return;
    busy = true;
    try {
      const { slices, events } = state.refresh();
      const changed = Object.keys(slices).length > 0;
      if (changed) hub.broadcast('patch', { rev: state.rev, slices });
      for (const e of events) hub.broadcast('event', e);
      onCycle({ changed: changed || events.length > 0 });
      errors = 0;
    } catch (e) {
      errors++;
      if (errors === 1 || errors % 40 === 0) log(`poll error (${errors}): ${e.stack || e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(cycle, intervalMs);
  return { stop: () => clearInterval(timer), cycle };
}
