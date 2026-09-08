# Hibro Node Engine Lifecycle

Hibro Node separates three concepts that must not be conflated:

1. an **Engine** is a Node-wide executable such as Claude Code, Codex CLI or OpenClaw;
2. an **AgentDefinition** is versioned Agent-as-Code configuration;
3. a **Run** is one on-demand engine process in an Agent-private workspace.

Many Agents can share one Engine installation. Creating an Agent never starts a permanent CLI
process. The selected adapter starts the CLI only when a Run or conversation message is executed.

## Catalog and managed layout

The built-in catalog is an allowlist of official packages and recommended exact versions. Runtime
requests cannot supply package names, npm tags, URLs or arbitrary install commands. Managed copies
are stored under the Hibro Home:

```text
.hibro/engines/
├── state.json
├── .staging/
├── claude-code/versions/<version>/node_modules/.bin/claude
├── codex/versions/<version>/node_modules/.bin/codex
└── openclaw/versions/<version>/node_modules/.bin/openclaw
```

Installations are staged, checked for an executable, and atomically activated. A failed update keeps
the previous version usable. An interrupted operation is marked failed at the next startup and can
be retried. State is written atomically with mode `0600`; the directory uses mode `0700`.

The resolution order is:

1. enabled Hibro-managed version;
2. explicitly configured `HIBRO_*_BIN` or discovered executable;
3. unavailable.

Disabling an Engine is a Node policy and prevents new Runs even when a bundled or external binary
exists. Existing Runs are allowed to finish. A managed copy cannot be uninstalled while that Engine
has an active Run. Uninstall never deletes system or image-provided binaries.

## API and CLI

```http
GET  /v1/engines
POST /v1/engines/:id/install
POST /v1/engines/:id/update
POST /v1/engines/:id/activate
POST /v1/engines/:id/enable
POST /v1/engines/:id/disable
POST /v1/engines/:id/uninstall
```

Install and update accept optional JSON `{ "version": "1.2.3" }`; omitted versions use the catalog
recommendation. Only exact versions are accepted. The same operations are available locally:

```bash
npm run engine -- list
npm run engine -- install codex
npm run engine -- update codex --version 0.145.0
npm run engine -- disable openclaw
npm run engine -- enable openclaw
npm run engine -- uninstall openclaw
```

Engine authentication is deliberately separate. Installation records never contain API keys,
tokens or login material. The Engine page reports authentication readiness after installation.

## Docker and Native installation

The one-command installer accepts `--engines all`, `--engines none`, or a comma-separated subset.
Docker uses the selection for reproducible image-bundled CLIs; later UI installations live in the
persistent `/data/.hibro/engines` volume. Native installs the selected CLIs into the service user's
Hibro Home rather than global npm directories.

For restricted networks, `HIBRO_DEBIAN_MIRROR` selects the Docker build mirror host and
`HIBRO_NPM_REGISTRY` selects the official-package registry. The package allowlist and exact-version
validation remain in force when a mirror is used.

Core receives `installed`, `enabled`, runtime version, managed version and readiness in `node.hello`.
After a lifecycle change, Node reconnects and sends a fresh hello because protocol v1 permits one
hello per WebSocket connection.
Schedulers can therefore select compatible Nodes. Remote installation is not implicit: a missing
Engine blocks placement until the Node owner installs it or explicitly enables a future Core-managed
installation policy.
