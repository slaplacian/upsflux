# upsflux

Reads the JSON lines that [`tsups`](https://github.com/slaplacian/tsups) prints
and writes them to **InfluxDB 3**. No dependencies; Node 20.12+.

```sh
tsups monitor --json | upsflux --env-file .env --tag ups=senoid15
```

| tsups line              | Database                                  | Table        |
|-------------------------|-------------------------------------------|--------------|
| `{"type":"sample",...}` | `INFLUX_DATABASE` (`infrastructure`)      | `ups_status` |
| `{"type":"event",...}`  | `INFLUX_EVENTS_DATABASE` (same as above)  | `ups_event`  |
| `tsups status --json`   | same as sample                            | `ups_status` |

Anything else (non-JSON, other objects) is ignored.

**`ups_status`**: tags `host` + `--tag`s; float fields `inputVoltage`,
`inputFaultVoltage`, `outputVoltage`, `loadPercent`, `frequency`,
`batteryVoltage`, `batteryNominal`, `batterySOC`, `temperature`; string
`status`; booleans `utilityFail`, `batteryLow`, `bypass`, `upsFailed`,
`standby`, `testInProgress`, `shutdownActive`, `beeperOn`.

**`ups_event`**: tags `code` (`UTILITY_FAIL`, `COMM_FAIL`, ...), `severity`
(`info` / `success` / `warning` / `critical`), `bit`, `host`; fields
`message`, `count=1i`, and the readings at the time of the event
(`inputVoltage`, `outputVoltage`, `loadPercent`, `batteryVoltage`, `batterySOC`).

## Setup

```sh
npm install -g tsups upsflux
cp .env.example .env   # fill in URL, token, database
```

The token needs write access to the database(s). InfluxDB 3 Core creates a
database on first write, so a typo in `INFLUX_DATABASE` silently creates a new
one; check the name.

## Behaviour

- Samples are batched and sent every `--flush-interval` seconds (10); events
  are sent immediately.
- If InfluxDB is unreachable or returns an error, points stay in memory
  (newest 50 000 per database) and are sent once it is back. Malformed lines
  (HTTP 400) are dropped and logged; InfluxDB 3 still stores the valid lines
  of the same batch.
- On end of input, Ctrl+C or SIGTERM, buffered points are flushed first.
- `--dry-run` prints the line protocol instead of sending; `--tee` echoes
  the input so you still see tsups output.

Uses `/api/v3/write_lp` with millisecond timestamps.

## Development

```sh
npm test        # line protocol conversion and the writer against a fake server
npm link        # puts your working copy of `upsflux` on your PATH
```

## License

MIT
