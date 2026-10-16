#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { toPoint } from './lineprotocol.js';
import { InfluxWriter } from './writer.js';
import { parseCli, exitOnClosedPipe } from './args.js';

const HELP = `upsflux - send tsups output to InfluxDB

Usage: tsups monitor --json | upsflux [options]

Samples go to table "ups_status"; events such as UTILITY_FAIL or COMM_FAIL go
to table "ups_event" (tagged by code and severity). Both are written to
--database unless --events-database is set. Non-JSON lines are ignored.
Requires InfluxDB 3.

Options:
      --url <url>               InfluxDB URL, e.g. http://localhost:8181 (env INFLUX_URL)
      --token <token>           API token               (env INFLUX_TOKEN)
      --database <name>         Database                (env INFLUX_DATABASE, default "infrastructure")
      --events-database <name>  Database for events     (env INFLUX_EVENTS_DATABASE, default: --database)
      --tag <key=value>         Extra tag on every point; repeatable (default host=<hostname>)
      --flush-interval <sec>    Seconds between sample writes (default 10; events are sent at once)
      --env-file <path>         Load INFLUX_* variables from a file
      --tee                     Echo every input line to stdout
      --dry-run                 Print line protocol instead of sending
  -v, --verbose                 Log each write
  -h, --help                    Show this help
`;

const { values: opt } = parseCli({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    database: { type: 'string' },
    'events-database': { type: 'string' },
    tag: { type: 'string', multiple: true },
    'flush-interval': { type: 'string', default: '10' },
    'env-file': { type: 'string' },
    tee: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
}, 'upsflux');

if (opt.help) {
  console.log(HELP);
  process.exit(0);
}

const log = (msg) => console.error(`[upsflux] ${msg}`);

// --dry-run | head: flush what is buffered, then exit.
exitOnClosedPipe(() => finish());

try {
  if (opt['env-file']) process.loadEnvFile(opt['env-file']);
} catch (err) {
  log(`cannot read ${opt['env-file']}: ${err.message}`);
  process.exit(2);
}

const env = process.env;
const cfg = {
  url: opt.url ?? env.INFLUX_URL,
  token: opt.token ?? env.INFLUX_TOKEN,
  database: opt.database ?? env.INFLUX_DATABASE ?? 'infrastructure',
};
cfg.eventsDatabase = opt['events-database'] ?? env.INFLUX_EVENTS_DATABASE ?? cfg.database;

const tags = { host: hostname().replace(/\.local$/, '') };
for (const t of opt.tag ?? []) {
  const i = t.indexOf('=');
  if (i < 1) {
    log(`bad --tag "${t}", expected key=value`);
    process.exit(2);
  }
  tags[t.slice(0, i)] = t.slice(i + 1);
}

if (!opt['dry-run'] && !cfg.url) {
  log('no InfluxDB URL; set INFLUX_URL, pass --url, or use --dry-run');
  process.exit(2);
}

const writer = opt['dry-run']
  ? null
  : new InfluxWriter({ url: cfg.url, token: cfg.token, log });

const flush = async () => {
  if (!writer) return;
  const before = writer.written;
  await writer.flush();
  if (opt.verbose && writer.written > before) log(`wrote ${writer.written - before} point(s)`);
};

const timer = setInterval(flush, Math.max(1, Number(opt['flush-interval'])) * 1000);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  if (opt.tee) console.log(raw);
  const text = raw.trim();
  if (!text.startsWith('{')) return;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    if (opt.verbose) log(`skipping invalid JSON: ${text.slice(0, 80)}`);
    return;
  }
  const point = toPoint(obj, tags);
  if (!point) return;
  const db = point.kind === 'event' ? cfg.eventsDatabase : cfg.database;
  if (!writer) {
    console.log(`[${db}] ${point.line}`);
    return;
  }
  writer.add(db, point.line);
  if (point.kind === 'event') flush();
});

let closing = false;
const finish = async (code = 0) => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await flush();
  if (writer?.pending) {
    log(`exiting with ${writer.pending} unsent point(s)`);
    code ||= 1;
  }
  process.exit(code);
};

rl.on('close', () => finish());
// Ctrl+C reaches every process in the pipeline; send what is buffered first.
process.on('SIGINT', () => finish());
process.on('SIGTERM', () => finish());
