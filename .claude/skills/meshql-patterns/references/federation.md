# Federation: Resolvers and Query Templates

Graphlettes federate by calling **other graphlettes' GraphQL queries over HTTP**, never by joining at the storage layer. Each entity owns its own store; relations are resolved at query time. This is true even when both entities live in the same process/deployment — meshobj always federates via `fetch()`, there is no in-process resolver shortcut the way meshql-rs has (see "Always HTTP" below).

## Query templates

Defined per graphlette under `rootConfig` in the HOCON config (`core/common/src/index.ts`'s `SingletonSchema`/`VectorSchema`/`RootConfigSchema`). A template is Handlebars text that renders to a JSON query object:

```hocon
singletons = [
  { name = "getById",   query = "{\"id\": \"{{id}}\"}" }
]
vectors = [
  { name = "getByFarm", query = "{\"payload.farm_id\": \"{{id}}\"}" }
]
```

- `singletons` vs `vectors` controls whether the GraphQL field returns an object or a list — it must match the schema's return type (`Coop` vs `[Coop]`).
- The special key `id` addresses the Envelope id on every adapter. **Payload fields are addressed differently per adapter and are not portable**: `"payload.<field>"` in Mongo's JSON filter document, and an explicit JSON extraction inside a SQL `WHERE` fragment elsewhere — `payload->>'<field>'` (postgres), `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.<field>'))` (mysql), `json_extract(payload, '$.<field>')` (sqlite). A bare field name is never right; on Mongo it fails silently with an empty result. See SKILL.md, "Query templates: the shape is per-adapter".
- Args come from the GraphQL call's arguments — `getByFarm(id: "farm-1")` renders `{"payload.farm_id": "farm-1"}` against the target entity's store.

## The resolver construct

Unlike frameworks that expose separate "child→parent" vs "parent→children" resolver builders, meshobj has **one** `resolvers` list per graphlette's `rootConfig` (`ResolverSchema`: `{name, id?, queryName, url}`). Whether a resolver reads as one-to-one or one-to-many is decided entirely by which query (`singleton` or `vector`) `queryName` points at on the *target* graphlette — the resolver entry itself doesn't declare cardinality.

For Farm 1—N Coop (coop payload carries `farm_id`), from `examples/farm/config/config.conf`:

**Child → parent:** on the coop graphlette's `rootConfig`:

```hocon
resolvers = [
  {
    name = "farm"
    id = "farm_id"
    queryName = "getById"
    url = "http://farm:"${?PORT}"/farm/graph"
  }
]
```

At resolve time (`core/graphlette/src/graph/dto.ts`), the framework reads `self["farm_id"]` off the already-resolved Coop object and calls `getById(id: "<that value>")` against the target URL.

**Parent → children:** on the farm graphlette's `rootConfig`:

```hocon
resolvers = [
  { name = "coops", queryName = "getByFarm", url = "http://farm:"${port}"/coop/graph" }
]
```

`id` is omitted, which defaults to `'id'` — "pass this object's own `id` as the foreign key." The target graphlette (`coop`) must define `getByFarm` as a `vector` with template `{"payload.farm_id": "{{id}}"}` — **the relation query lives on the child entity's `rootConfig`, the resolver on the parent's.** Forgetting one half is the most common federation bug.

Chains work the same way one hop at a time: `examples/farm/config/config.conf`'s coop graphlette also resolves `hens` (→ `getByCoop` on the hen graphlette) and `hens.layReports` (→ `getByHen` on the lay_report graphlette) — each is its own independent resolver entry, not a special nested-path feature.

## Always HTTP (no in-process shortcut)

Every resolver target is a `url` — even `http://farm:${port}/coop/graph` in the single-process `examples/farm` deployment is a real loopback HTTP call to the same running server. There is no registry-based in-process resolution like meshql-rs's `ResolverRegistry`. Two consequences:

- **Batching matters more here.** `core/graphlette/src/graph/dataLoaderFactory.ts` provides a `DataLoader` per `(url, queryName)` pair per request (`dto.ts`'s `assignResolver`), so N sibling objects resolving the same relation in one query get batched into fewer subgraph calls instead of N HTTP round-trips. This is automatic — you don't configure it per resolver — but be aware a resolver you add is subject to it.
- **A resolver `url` can point at a genuinely separate, independently deployed meshql service** exactly the same way it points at a co-located one — federation to another team's service is not a different code path, just a different URL. `examples/twofarms/` and `examples/farm-cqrs/`'s split read/write services are worked examples of multiple deployments federating over HTTP.

## Temporal propagation

The root query's effective `at` propagates through every resolver hop automatically: `addTimestampToQuery` (`core/graphlette/src/graph/subgraph.ts`) parses the outgoing subgraph query's AST and injects an `at` argument matching the parent's resolution timestamp if the query doesn't already carry one. A point-in-time read of a farm returns its coops — and their hens — *as they were at that time*, with no per-resolver code needed to make that true. Don't bypass this by hand-building subgraph query strings outside `dto.ts`/`subgraph.ts`.

## Checklist for a new relation

1. Child payload carries `<parent>_id` (snake_case) — add it to the child's JSON Schema.
2. Child `rootConfig`: `vector` query `getBy<Parent>` with template `{"payload.<parent>_id": "{{id}}"}`.
3. Child schema: `parent` field + local parent type; child `rootConfig`: resolver entry `{name: "parent", id: "<parent>_id", queryName: "getById", url: "..."}`.
4. Parent schema: `children: [Child]` field + local child type; parent `rootConfig`: resolver entry `{name: "children", queryName: "getBy<Parent>", url: "..."}` (no `id` — defaults to the parent's own `id`).
5. Both queries take `at: Float` in the schema (invariant 3 — this is what lets step-6 propagation work).
6. Confirm the `url` in both directions actually resolves from wherever the process runs (Docker service name, `localhost`, or a real external host) — a wrong host here fails silently as an empty federation result, not a startup error.
