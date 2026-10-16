import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { toLine, toPoint, int } from '../src/lineprotocol.js';
import { InfluxWriter } from '../src/writer.js';

// Real `tsups monitor --json` output captured from a TS Shara Senoid 1.5 kVA.
const SAMPLE = {
  type: 'sample',
  ts: 1791930586981,
  inputVoltage: 223,
  inputFaultVoltage: 223,
  outputVoltage: 112,
  loadPercent: 9,
  frequency: 60,
  batteryVoltage: 27,
  batteryNominal: 24,
  batterySOC: 100,
  temperature: 26,
  status: '00001001',
  flags: {
    utilityFail: false,
    batteryLow: false,
    bypass: false,
    upsFailed: false,
    standby: true,
    testInProgress: false,
    shutdownActive: false,
    beeperOn: true,
  },
};

test('sample -> ups_status line', () => {
  const p = toPoint(SAMPLE, { host: 'mac' });
  assert.equal(p.kind, 'sample');
  assert.equal(
    p.line,
    'ups_status,host=mac inputVoltage=223,inputFaultVoltage=223,outputVoltage=112,loadPercent=9,' +
      'frequency=60,batteryVoltage=27,batteryNominal=24,batterySOC=100,temperature=26,status="00001001",' +
      'utilityFail=false,batteryLow=false,bypass=false,upsFailed=false,standby=true,' +
      'testInProgress=false,shutdownActive=false,beeperOn=true 1791930586981',
  );
});

test('`tsups status --json` (no type field) is a sample', () => {
  const { type, ...status } = SAMPLE;
  assert.equal(toPoint({ port: '/dev/x', ...status }).kind, 'sample');
});

test('event -> ups_event line with code/severity tags and sample context', () => {
  const ev = {
    type: 'event',
    ts: 1791930590000,
    code: 'UTILITY_FAIL',
    message: 'Utility power failure, running on battery',
    severity: 'warning',
    bit: 'utilityFail',
    sample: SAMPLE,
  };
  assert.deepEqual(toPoint(ev, { host: 'mac' }), {
    kind: 'event',
    line:
      'ups_event,bit=utilityFail,code=UTILITY_FAIL,host=mac,severity=warning ' +
      'message="Utility power failure, running on battery",count=1i,inputVoltage=223,outputVoltage=112,' +
      'loadPercent=9,batteryVoltage=27,batterySOC=100 1791930590000',
  });
});

test('COMM_FAIL event without sample or bit', () => {
  const p = toPoint({ type: 'event', ts: 1, code: 'COMM_FAIL', message: 'no UPS found', severity: 'warning' });
  assert.equal(p.line, 'ups_event,code=COMM_FAIL,severity=warning message="no UPS found",count=1i 1');
});

test('escaping', () => {
  assert.equal(
    toLine('m x', { 'a b': 'c,d=e' }, { s: 'say "hi" \\ ok', n: int(3.9) }, 0),
    'm\\ x,a\\ b=c\\,d\\=e s="say \\"hi\\" \\\\ ok",n=3i',
  );
});

test('unknown objects are ignored', () => {
  assert.equal(toPoint({ found: true, path: '/dev/x' }), null);
  assert.equal(toPoint(null), null);
});

function fakeInflux(statuses) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      res.statusCode = statuses.shift() ?? 204;
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

test('writer posts per database and keeps points while Influx fails', async () => {
  const { server, requests, url } = await fakeInflux([503]);
  const logs = [];
  const w = new InfluxWriter({ url, token: 'tok', log: (m) => logs.push(m) });
  w.add('infrastructure', 'a v=1 1');
  w.add('events', 'b v=1 1');

  await w.flush(); // 503: nothing lost
  assert.equal(w.pending, 2);
  assert.match(logs[0], /HTTP 503/);

  await w.flush();
  assert.equal(w.pending, 0);
  assert.equal(w.written, 2);
  assert.equal(requests[1].url, '/api/v3/write_lp?db=infrastructure&precision=millisecond');
  assert.equal(requests[1].auth, 'Bearer tok');
  assert.equal(requests[2].url, '/api/v3/write_lp?db=events&precision=millisecond');
  assert.equal(requests[2].body, 'b v=1 1');
  server.close();
});

test('writer drops data Influx rejects as malformed', async () => {
  const { server, url } = await fakeInflux([400]);
  const w = new InfluxWriter({ url, log: () => {} });
  w.add('ups', 'bad');
  await w.flush();
  assert.equal(w.pending, 0);
  assert.equal(w.written, 0);
  server.close();
});

test('writer buffers when Influx is unreachable and caps the buffer', async () => {
  const w = new InfluxWriter({ url: 'http://127.0.0.1:1', maxBuffer: 3, log: () => {} });
  for (let i = 0; i < 5; i++) w.add('ups', `m v=${i}`);
  await w.flush();
  assert.deepEqual(w.queues.get('ups'), ['m v=2', 'm v=3', 'm v=4']);
});
