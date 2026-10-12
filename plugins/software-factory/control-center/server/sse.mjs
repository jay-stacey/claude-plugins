// Server-Sent Events hub: clients, a 500-message ring for Last-Event-ID resume, heartbeats.
export const RING_SIZE = 500;
export const HEARTBEAT_MS = 15000;

export class SseHub {
  constructor({ snapshot, heartbeatMs = HEARTBEAT_MS, onChange = () => {} }) {
    this.snapshot = snapshot; // () => snapshot object
    this.clients = new Set();
    this.ring = [];
    this.seq = 0;
    this.onChange = onChange;
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.timer.unref?.();
  }

  frame(id, type, data) {
    return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  broadcast(type, data) {
    const id = ++this.seq;
    const text = this.frame(id, type, data);
    this.ring.push({ id, text });
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const c of this.clients) this.write(c, text);
    return id;
  }

  write(client, text) {
    try {
      client.res.write(text);
    } catch {
      this.drop(client);
    }
  }

  add(req, res, lastEventId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const client = { res };
    this.clients.add(client);
    this.onChange(this.clients.size);
    const last = Number.parseInt(lastEventId, 10);
    const oldest = this.ring.length ? this.ring[0].id : this.seq + 1;
    if (Number.isFinite(last) && last >= oldest - 1 && last <= this.seq) {
      for (const m of this.ring) if (m.id > last) this.write(client, m.text);
    } else {
      this.write(client, this.frame(this.seq, 'snapshot', this.snapshot()));
    }
    const done = () => this.drop(client);
    req.on('close', done);
    res.on('error', done);
    return client;
  }

  drop(client) {
    if (!this.clients.delete(client)) return;
    try { client.res.end(); } catch { /* already closed */ }
    this.onChange(this.clients.size);
  }

  heartbeat() {
    for (const c of this.clients) this.write(c, `: heartbeat ${Date.now()}\n\n`);
  }

  close() {
    clearInterval(this.timer);
    for (const c of [...this.clients]) this.drop(c);
  }
}
