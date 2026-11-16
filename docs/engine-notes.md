# Engine notes

Behaviour verified against `rushdb/rushdb:3.0.10` while building this. These are the
things that are not obvious from the protocol surface and cost time to discover.

## Protocol

One endpoint. No REST resources.

```
POST /protocol/v1/execute
Authorization: Bearer <token>
X-RushDB-Tenant: <tenant>
{"protocolVersion":1,"context":{"scope":"<tenant>"},"operation":{...}}
```

Multitenant mode requires **both** the header and `context.scope`; either alone is
rejected with `403 missing_scope`. `GET /` is 404 — the dashboard belongs to the older
Neo4j-backed `rushdb/platform` image and would show nothing against redb data.

## Startup

- The engine **refuses to listen on a non-loopback address with its built-in default
  token** (`local-token`): `refusing to listen on non-loopback 0.0.0.0 with the default
  token; set --token`.
- `config.yml` in the data directory is the **source of truth**. A flag that disagrees
  with it is a hard startup failure: `config.yml disagrees with explicitly supplied
  startup flags ... edit it or drop the flag`. So the container rewrites `listen-addr` in
  `config.yml` instead of passing `--listen`.
- Tenancy mode is an isolation invariant baked into the data directory. A store created
  multitenant cannot be reopened single-tenant.

## Indexes

**Text and vector indexes live behind different describe kinds.**

| Request | Returns |
|---|---|
| `describe indexes` | text indexes only |
| `describe vectorIndexes` | vector indexes only |

A viewer built on `indexes` alone reports a tenant with a populated vector index as
having none.

### Vector index lifecycle

```jsonc
// create — createVector, not create
{"kind":"index","index":{"kind":"createVector","definition":{
  "name":"fact_embedding","label":"MEMORY_FACT","property":"embedding","dimensions":1024}}}

// populate — the only way vectors get in
{"kind":"index","index":{"kind":"upsertVectors","name":"fact_embedding","items":[
  {"recordId":"01a1…","vector":[…]}]}}

// query — `index` is mandatory (resources.require-vector-index-name is on)
{"kind":"query","query":{"kind":"vector","query":{
  "labels":["MEMORY_FACT"],"limit":40,"vector":[…],
  "property":"embedding","index":"fact_embedding"}}}
```

Things that will bite:

- `create` with a vector kind fails `internal execution error` for every value tried
  (`vector`, `ann`, `hnsw`, `embedding`, `ivf`, `flat`). Only `createVector` works.
- **The index does not follow record writes.** A record created with an `embedding`
  property leaves the index `behind` with `unindexedRecords: 1`, and `revalidateVector`
  does **not** backfill it. Every write needs an explicit `upsertVectors`.
- `items`, not `vectors`, and each entry is `{recordId, vector}`.
- Vectors do **not** need to exist as a record property. Index-only works, which is what
  this project relies on to keep fact records ~83 bytes.
- `createVector` is idempotent and succeeds on a property that does not exist yet
  (`status: "awaiting_vectors"`).
- Dimensions must match the model. A mismatch produces vectors the index cannot use, so
  the service validates the length on every response and fails loudly.

Query results carry `score` per record and `vectorSearch: {mode, pool}`. Scoring is
cosine: identical vector `1.0`, a rotated one `0.267`. Underneath it is usearch
(`revalidateVector` reports `provider: "usearch"`). `mode` has only ever been observed as
`"exact"`, i.e. a brute-force scan over the pool.

`describe indexes` shape: `{name, label, property, kind, state, consistency, pending}`.
`describe vectorIndexes` shape adds `dimensions, similarity, model, generation, owner,
nameSource, indexedRecords, totalRecords, unindexedRecords, staleBindings,
retiredBindings, externalBindings`.

**`model` is always null.** Vectors are supplied by a client, so the engine has no idea
which model produced them; `externalBindings` is its only acknowledgement that they were
not derived internally. That is why the viewer needs an annotations file.

## Not exercised

`hybrid` (text + vector in one query) exists as a query kind but every request shape was
rejected with `expected struct HybridTextLeg`. This project fuses in TypeScript instead.

## Other useful operations

```
describe: schema | labels | properties | queryLanguages | capabilities | buildInfo |
          explain | explainVector | indexes | vectorIndexes | vectorIndex | names |
          schemaSummary | valueOverlap
query:    gremlinBytecode | statement | records | cursor | record | relationships |
          propertyValues | vector | joinPairs | vectorIndexCandidates | text | hybrid |
          exportCsv | searchValues
index:    create | drop | createVector | dropVector | upsertVectors | revalidateVector
```

`exportCsv` and the `--export` / `--restore` server flags are the supported way to move a
store; do not copy a live `*.redb`.
