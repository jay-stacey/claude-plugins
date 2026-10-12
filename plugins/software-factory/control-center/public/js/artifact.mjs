// Artifact viewer side panel: markdown (escaped renderer), text/log in <pre>, html in a sandboxed iframe.
import { html, h, useEffect, useState } from './html.mjs';
import { getArtifact, ApiError } from './api.mjs';
import { Drawer, Icon, useArtifactPath, closeArtifact } from './components.mjs';
import { mdToVNodes } from './lib/md.mjs';

function errorText(e) {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'This file does not exist (yet).';
    if (e.status === 403) return 'The server does not allow reading this path.';
    if (e.status === 400) return 'This path is not valid.';
    return e.message;
  }
  return 'Could not load the file.';
}

async function openFullSize(path) {
  // Open the tab synchronously (popup blockers), then point it at a fresh one-use ticket.
  const w = window.open('', '_blank');
  try {
    const r = await getArtifact(path);
    if (w && r && r.ticket_url) {
      w.opener = null;
      w.location.replace(r.ticket_url);
    } else if (w) w.close();
  } catch {
    if (w) w.close();
  }
}

export function ArtifactViewer() {
  const path = useArtifactPath();
  const [st, setSt] = useState({ loading: false, data: null, error: null });

  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    setSt({ loading: true, data: null, error: null });
    getArtifact(path)
      .then((data) => alive && setSt({ loading: false, data, error: null }))
      .catch((e) => alive && setSt({ loading: false, data: null, error: errorText(e) }));
    return () => { alive = false; };
  }, [path]);

  const name = path ? String(path).split(/[\\/]/).pop() : '';
  const d = st.data;
  let body = null;
  if (st.loading) body = html`<p class="muted" role="status">Loading ${name}...</p>`;
  else if (st.error) body = html`<p class="tone-danger callout" role="alert"><${Icon} name="warn" />${st.error}</p>`;
  else if (d && d.kind === 'html' && d.ticket_url) {
    body = html`<div class="artifact-html">
      <p class="artifact-actions">
        <button type="button" class="btn" onClick=${() => openFullSize(path)}><${Icon} name="external" />Open full size</button>
        <span class="muted small">Runs in a sandbox with scripts only. No access to the dashboard.</span>
      </p>
      <iframe class="artifact-frame" sandbox="allow-scripts" src=${d.ticket_url} title=${`Mockup ${name}`} referrerpolicy="no-referrer"></iframe>
    </div>`;
  } else if (d && d.kind === 'markdown') {
    body = html`<div class="md">${mdToVNodes(d.text || '', h)}</div>`;
  } else if (d) {
    body = html`<pre class="artifact-pre" tabindex="0">${d.text || ''}</pre>`;
  }

  return html`<${Drawer} open=${!!path} onClose=${closeArtifact} title=${name || 'Artifact'} wide labelId="artifact-title">
    <p class="artifact-path mono small muted">${path}</p>
    ${d && d.truncated && html`<p class="callout tone-warn"><${Icon} name="warn" />File is large; showing the first 512 KB only.</p>`}
    ${body}
  <//>`;
}
