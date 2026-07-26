# ADR-0001: Hibro Node storage uses SQLite for runtime data

Status: Accepted

## Decision

Hibro Node uses one local SQLite database at `HIBRO_NODE_DATA_DIR/hibro.db` for:

- Runs;
- ordered Run events;
- Core delivery outbox;
- future Core sequence/resume state.

Agent definitions and system settings remain small, human-readable JSON files for now.

## Why

The original per-Run JSON and JSONL layout was easy to inspect, but six Agents, concurrent engine
events and eventual Core replay require:

- atomic updates;
- indexed filtering;
- ordered event reads;
- durable idempotency and outbox state;
- safe restart recovery without scanning every directory.

SQLite provides those properties without operating a separate database server. Node.js 24 ships a
built-in SQLite API, so Hibro Node adds no native npm dependency.

## Migration

On first SQLite startup, Hibro Node imports existing `runs/*/state.json` and
`runs/*/events.jsonl` records. Import is idempotent and records a migration marker. Legacy files
are retained as a recovery backup and are no longer written by the production server.

## Operational defaults

- WAL journal mode;
- foreign keys enabled;
- normal synchronous mode;
- 5 second busy timeout;
- events cascade when a Run is pruned.

## Reconsider when

Move to an external database only if one Node process must be horizontally replicated against the
same storage volume. That is intentionally outside the Hibro Node v1 model; cross-node aggregation
belongs in Hibro Core.
