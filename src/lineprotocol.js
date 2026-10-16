// InfluxDB line protocol for tsups JSON output.
// https://docs.influxdata.com/influxdb3/core/reference/line-protocol/

const escKey = (s) => String(s).replace(/\n/g, ' ').replace(/[,= ]/g, (c) => '\\' + c);
const escMeasurement = (s) => String(s).replace(/\n/g, ' ').replace(/[, ]/g, (c) => '\\' + c);
const escString = (s) => String(s).replace(/["\\]/g, (c) => '\\' + c);

// Wrap a number to write it as an integer field ("1i") instead of a float.
export const int = (n) => ({ int: Math.trunc(n) });

function formatField(v) {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string') return `"${escString(v)}"`;
  if (v && typeof v === 'object' && 'int' in v) return `${v.int}i`;
  return null;
}

// Returns one line, or null when there are no writable fields.
export function toLine(measurement, tags, fields, tsMs) {
  const tagPart = Object.entries(tags)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1)) // sorted tags are faster for Influx to ingest
    .map(([k, v]) => `,${escKey(k)}=${escKey(v)}`)
    .join('');
  const fieldPart = Object.entries(fields)
    .map(([k, v]) => [k, formatField(v)])
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${escKey(k)}=${v}`)
    .join(',');
  if (!fieldPart) return null;
  return `${escMeasurement(measurement)}${tagPart} ${fieldPart}${tsMs ? ' ' + Math.trunc(tsMs) : ''}`;
}

// Numeric reading fields of a tsups Q1 sample. All written as floats so a
// reading like 223 and 223.5 never clash on field type.
const SAMPLE_NUMBERS = [
  'inputVoltage',
  'inputFaultVoltage',
  'outputVoltage',
  'loadPercent',
  'frequency',
  'batteryVoltage',
  'batteryNominal',
  'batterySOC',
  'temperature',
];

// Subset of the sample stored with each event, so an alert can show context.
const EVENT_CONTEXT = ['inputVoltage', 'outputVoltage', 'loadPercent', 'batteryVoltage', 'batterySOC'];

const isSample = (o) => o.type === 'sample' || (o.type === undefined && typeof o.status === 'string' && 'inputVoltage' in o);

// Maps one parsed tsups JSON object to { kind: 'sample' | 'event', line }, or null.
// `tsups monitor --json` emits {type:"sample"} and {type:"event"}; `tsups status --json`
// emits a sample without a type.
export function toPoint(obj, extraTags = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const ts = Number(obj.ts) || Date.now();

  if (isSample(obj)) {
    const fields = {};
    for (const k of SAMPLE_NUMBERS) if (typeof obj[k] === 'number') fields[k] = obj[k];
    fields.status = obj.status;
    for (const [k, v] of Object.entries(obj.flags ?? {})) fields[k] = Boolean(v);
    const line = toLine('ups_status', extraTags, fields, ts);
    return line && { kind: 'sample', line };
  }

  if (obj.type === 'event') {
    const fields = { message: obj.message ?? '', count: int(1) };
    for (const k of EVENT_CONTEXT) if (typeof obj.sample?.[k] === 'number') fields[k] = obj.sample[k];
    const tags = { ...extraTags, code: obj.code, severity: obj.severity, bit: obj.bit };
    const line = toLine('ups_event', tags, fields, ts);
    return line && { kind: 'event', line };
  }

  return null;
}
