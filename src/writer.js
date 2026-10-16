// Buffered writer for the InfluxDB 3 HTTP API (/api/v3/write_lp).

const MAX_LINES_PER_REQUEST = 5000;

export class InfluxWriter {
  constructor({ url, token, maxBuffer = 50000, fetch = globalThis.fetch, log = () => {} }) {
    this.base = url.replace(/\/+$/, '');
    this.token = token;
    this.maxBuffer = maxBuffer;
    this.fetch = fetch;
    this.log = log;
    this.queues = new Map(); // database -> pending lines
    this.flushing = null;
    this.failing = false;
    this.written = 0;
  }

  get pending() {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  add(db, line) {
    let q = this.queues.get(db);
    if (!q) this.queues.set(db, (q = []));
    q.push(line);
    // While Influx is unreachable (e.g. the network is down during a power
    // cut), keep the newest points and drop the oldest.
    if (q.length > this.maxBuffer) q.splice(0, q.length - this.maxBuffer);
  }

  // Concurrent callers share the running flush, then run one more so nothing
  // added meanwhile waits for the next timer tick.
  async flush() {
    while (this.flushing) await this.flushing;
    this.flushing = this.#flushAll().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async #flushAll() {
    for (const [db, q] of this.queues) {
      while (q.length) {
        const batch = q.slice(0, MAX_LINES_PER_REQUEST);
        const result = await this.#post(db, batch);
        if (result === 'retry') return;
        q.splice(0, batch.length);
        if (result === 'ok') this.written += batch.length;
      }
    }
  }

  async #post(db, lines) {
    const params = new URLSearchParams({ db, precision: 'millisecond' });
    let res;
    try {
      res = await this.fetch(`${this.base}/api/v3/write_lp?${params}`, {
        method: 'POST',
        headers: {
          ...(this.token && { Authorization: `Bearer ${this.token}` }),
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: lines.join('\n'),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      return this.#fail(`cannot reach ${this.base}: ${err.cause?.message ?? err.message}`);
    }
    if (res.ok) {
      if (this.failing) this.log(`influx reachable again; sending ${this.pending} buffered point(s)`);
      this.failing = false;
      return 'ok';
    }
    const body = (await res.text().catch(() => '')).slice(0, 300);
    // Malformed lines never succeed on retry. InfluxDB 3 has already stored the
    // valid lines of a partial write, so drop the batch instead of blocking the queue.
    if (res.status === 400 || res.status === 422) {
      this.log(`influx rejected point(s) for database "${db}" (HTTP ${res.status}): ${body}`);
      return 'dropped';
    }
    return this.#fail(`HTTP ${res.status} writing to database "${db}": ${body}`);
  }

  #fail(msg) {
    if (!this.failing) this.log(`${msg}; buffering and retrying`);
    this.failing = true;
    return 'retry';
  }
}
