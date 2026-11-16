# agent-memory

Self-hosted long-term memory for coding agents, in one container.

The image bundles three things that are normally three deployments: a
[RushDB](https://github.com/rush-db/rushdb) engine, a memory service that ranks and
recalls facts, and a read-only viewer. One port, one volume, no database to operate and
no token to manage.

```
agent-memory
├── engine    RushDB, loopback only, never published
├── service   recall · capture · facts · embeddings · engine passthrough   :3001
└── viewer    labels, records, indexes, SQL console                        :3001
```

## Quick start

```sh
docker run -d --name agent-memory --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -v "$HOME/agent-memory:/data" \
  -e OPENROUTER_API_KEY=sk-or-... \
  ghcr.io/naharoo/agent-memory:latest
```

Open <http://127.0.0.1:3001>. `OPENROUTER_API_KEY` is optional — without it recall
falls back to keyword ranking and everything else works.

Then install the agent adapter:

```sh
docker run --rm -v ~/.config/opencode:/host \
  ghcr.io/naharoo/agent-memory:latest install-opencode
```

That copies the plugin into `~/.config/opencode/plugins/agent-memory/` and appends a
managed block to `AGENTS.md`. Run `npm install --omit=dev` in that directory once, then
restart or `/reload` the agent.

## What you get

### Memory API

| Endpoint | Purpose |
|---|---|
| `POST /recall` | `{directory, sessionID, message}` → `{tenant, block, stats}` |
| `POST /capture` | `{directory, sessionID, messages}` → one episode |
| `POST /remember` | `{directory, text, kind, subjectKey, pinned, supersedes}` |
| `POST /forget` | `{directory, id}` — deactivates, never deletes |
| `POST /reembed` | rebuilds the vector index from stored text |
| `POST /engine` | `{directory\|tenant, operation}` — raw protocol passthrough |
| `GET /health` | engine reachability and embedding status |

`directory` is how every endpoint picks a tenant; the mapping lives in the container, so
adapters stay dumb and stateless.

### Viewer

Labels, paginated records, a record drawer, a SQL console, and an index panel showing
text and vector indexes with dimensions, counts, and the embedding model. Tenant and
label are kept in the URL, so a refresh lands where you left off.

### MCP

`mcp/rushdb-mcp` is a stdio MCP wrapper over `POST /engine`. It resolves the tenant from
`$PWD` through `/api/tenant-for`, so it needs no token and no local config:

```jsonc
{
  "mcp": {
    "servers": {
      "rushdb": { "type": "local", "command": ["/path/to/mcp/rushdb-mcp"] }
    }
  }
}
```

## Configuration

Everything has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Enables semantic recall. Absent ⇒ keyword only. |
| `AGENT_MEMORY_EMBEDDINGS` | `on` | Master switch for semantic recall. |
| `AGENT_MEMORY_EMBEDDING_MODEL` | `mongodb/voyage-4-lite` | Any OpenRouter embedding model. |
| `AGENT_MEMORY_EMBEDDING_DIMENSIONS` | `1024` | Must match the model. |
| `AGENT_MEMORY_PORT` | `3001` | Service + viewer port. |
| `AGENT_MEMORY_HOST` | `0.0.0.0` | Bind address inside the container. |
| `AGENT_MEMORY_DATA_DIR` | `/data` | State root. |
| `AGENT_MEMORY_KEY` | — | Optional bearer key; off by default. |
| `AGENT_MEMORY_TENANTS` | — | Extra tenants to offer in the picker. |
| `AGENT_MEMORY_DEFAULT_TENANT` | `default` | Fallback tenant. |
| `AGENT_MEMORY_REFRESH_SECONDS` | `30` | Viewer auto-refresh default. |

## Data

```
/data
├── engine/     redb store, WAL, config.yml
├── config/     tenants.tsv, index-info.json
└── logs/       service.log
```

One bind mount holds everything. Back it up by stopping the container and copying the
directory — do not copy a live `*.redb`.

`config/tenants.tsv` maps directory prefixes to tenants; longest prefix wins, everything
else uses the default tenant. `config/index-info.json` supplies the embedding model label
the viewer shows, since the engine cannot report it (vectors are supplied by a client).

## Migrating from a bare RushDB setup

```sh
docker stop rushdb rushdb-ui
mkdir -p ~/agent-memory/{config,logs}
cp -R ~/.rushdb ~/agent-memory/engine
cp ~/.config/rushdb/tenants.tsv ~/agent-memory/config/
cp ~/.config/rushdb/index-info.json ~/agent-memory/config/
docker run -d --name agent-memory -p 127.0.0.1:3001:3001 \
  -v "$HOME/agent-memory:/data" -e OPENROUTER_API_KEY=sk-or-... \
  ghcr.io/naharoo/agent-memory:latest
```

The supervisor rewrites `listen-addr: 0.0.0.0` to `127.0.0.1` in the copied
`config.yml` on first start; the engine refuses to run on a non-loopback address with
its built-in token. Vectors live in the store and survive the move, but run
`memory_reembed` afterwards to prove the index is intact.

## Design notes

**Why the engine image is the base.** The `rushdb/rushdb` binary is dynamically linked
and its image has no shell, so the image cannot be assembled from a generic Debian. The
container starts from the engine image and adds the Node runtime from the matching
Debian release (both 12.15 / glibc 2.36).

**Why there is no token.** The engine requires one, so it uses its built-in default on
loopback inside the container and the port is never published. The service holds that
constant; agents never see a token. Set `AGENT_MEMORY_KEY` if you expose the service
beyond loopback.

**Why vectors are not stored on records.** A 1024-dimension vector as a record property
is ~4.8 KB per fact, which at the 500-fact recall scan would add ~2.4 MB to every turn.
Keeping vectors in the index alone leaves a fact ~83 bytes and makes `text` the single
source for re-embedding after a model change.

**Why one process serves the API and the viewer.** They share the engine client and the
config; splitting them would only add a proxy hop and a second port.

## Building

```sh
docker build -t agent-memory:local .
```

CI publishes `ghcr.io/naharoo/agent-memory` for `linux/amd64` and `linux/arm64` on every
push to `master`.

## License

MIT — see [LICENSE](LICENSE).
