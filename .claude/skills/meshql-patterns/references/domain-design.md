# Domain Design: Events, Projections, and Workers

This is the methodology meshql is built for. The immutable Envelope, temporal reads, and per-entity mesh aren't incidental features — they exist so that a system can be modeled as **events that happened** plus **domain models derived from those events**. If you internalize one pattern from this skill, make it this one. `examples/events/` is the worked reference in this repo — a real Debezium+Kafka CDC pipeline, not a hypothetical.

## The verbs and the nouns

There are exactly two kinds of thing, and the whole methodology is the bridge between them.

| Kind | What it is | Written by | Examples (`examples/events/`) |
|---|---|---|---|
| **Business event** (verb) | An immutable fact that happened | **Front ends** — the *only* write surface | `event` (`user_login`, `user_logout`, ...) |
| **Domain model** (noun) | A model derived by processing events | **Workers only** — never written directly by a front end | `processedevent` |

The key realization: **you keep both meshes, and a worker translates verbs into nouns.** Even a small system benefits from separating "this happened" (write-only, append-only) from "here's what that means" (read-optimized, derived, disposable). The only thing a front end ever writes is "this happened." Everything queried as a domain model is derived.

## The design workflow

1. **Identify the business events first.** What *happens* in the domain? Name them as facts (`user_login`, `order_placed`, `eggs_laid`). These are the only writes.
2. **Model the nouns.** What does the application query — entities and analytics? Each is a domain model built from events.
3. **Create the event mesh** (standard entity wiring, `references/adding-an-entity.md`). Create-only in practice; front ends `POST` here.
4. **Create the noun/projection mesh.** Same wiring, but nothing writes it through the public API in the intended design — only a worker does, and only via its own `/api` restlette (see below; meshobj doesn't currently enforce this with network policy, so document and code-review it).
5. **Build one worker per noun**, driven by CDC off the event mesh's store. It consumes the events it needs, transforms/folds them, and `POST`s the projection to its restlette.

## Run an actual event storm — don't skip straight to code

Steps 1–2 above are usually done badly when done silently in your head. **Event storming** (Alberto Brandolini's technique — sticky notes on a wall, or the written equivalent here) is a concrete process for doing them properly, and its categories map almost one-to-one onto meshql's own concepts. Produce this as a real, written artifact (a markdown doc is fine) *before* wiring anything — not a mental pass you skip straight through:

| Event storm artifact | meshql concept |
|---|---|
| **Domain Events** (past tense: "Order Placed", "User Logged In") | Event-mesh entities — the verbs. Each becomes a create-only restlette. |
| **Commands** (imperative: "Place Order", "Log In") | The REST payload shape of a `POST` to the corresponding event restlette. |
| **Actors / Roles** (who issues a command — a customer, an editor, a system) | Casbin roles (`CasbinAuth.create(casbinParams, jwtSubAuthorizer)`, `core/casbin_auth`, see "Auth beyond the default" in `SKILL.md`'s decision guide) — who's authorized to write which event. Don't default to the open/no-auth path once you've named actors; wire the roles you just identified. |
| **Policies** ("whenever X happens, then Y should happen") | **Workers.** A policy *is* a worker's fold-and-react loop — this is the most direct mapping in the table. A multi-step policy (event → triggers a new command → new event) is a worker that, after folding, also issues a follow-up write via REST. |
| **Aggregates** (the consistency boundary around a command) | The event mesh's write-side boundary — what one event commits atomically, and what a restlette's validators should actually check. |
| **Read Models / Views** (what someone needs to see) | Domain/projection meshes — the nouns from step 2 above, one worker each. |
| **Hotspots** (open questions, conflicting opinions, "we're not sure yet") | Write them down explicitly in the design artifact and flag them for the human. Don't silently resolve a hotspot with a guess. |

**Ground the storm in reality, not a blank page.** If an established product already exists in the same problem space, look at how it actually models the domain (its real entities, its real event/state lifecycle) before inventing your own from scratch — a green-field brainstorm reliably misses events and edge cases that someone else already discovered the hard way. Adapt the domain shape, not the code.

Once the storm is done, steps 3–5 above are close to mechanical: Domain Events → event mesh, Read Models → noun/projection mesh, Policies → workers.

## The write-path rule (the crux)

**Front ends write business events. They never write domain models.**

- The only intended public write surface is the **event** restlette (`POST /event/api`).
- The **projection** restlette (`POST /processedevent/api`) exists — meshobj's restlette doesn't have a built-in "internal-only" write guard — but by convention only the worker process calls it. Enforce this at the infrastructure layer (network policy / API gateway route rules — see `meshobj/CLAUDE.md`'s deployment model) if you need it enforced, not just documented.
- The application reads nouns via their **graphlettes** (`/processedevent/graph`), never computing them on the read path.

## The event → log bridge is CDC, never application code

Workers consume events from a Kafka topic. Getting events *onto* that topic is the part people get wrong. **It is change-data-capture from the storage layer — not a hook in the write path.** `examples/events/` demonstrates this concretely:

- The front end does exactly one write: `POST /event/api`, which commits to MongoDB. Done. No publish call anywhere in the restlette or `Crud`.
- **Debezium** watches the MongoDB replica set's change stream and mirrors every committed write to a Kafka topic (`events.<db>.<collection>`, per `debezium.source.topic.prefix` + `database.include.list` in `debezium/application.properties`). This is infrastructure configuration, not code you write per-entity.
- The worker (a plain **KafkaJS** consumer, `examples/events/src/processor.ts`) subscribes to that topic, parses Debezium's envelope, and `POST`s the resulting projection to `/processedevent/api` — a normal REST write, going through the projection's own restlette (validation included), not a direct database write.

Why this and not an application-level publish after the write:

- **No dual write.** A "write the DB, then publish the event" hook is two writes with no shared transaction. Crash in between and the row exists but the event never fired — the log is now a lie, and every projection built from it is silently wrong. CDC derives the event *from the committed write*, so the event cannot be lost relative to the data.
- **Correct order and time.** Debezium appends committed writes in commit order, carrying the store's timestamp, so replay and temporal reads reflect what actually happened rather than application wall-clock during a request. Note what the bridge's job *is*: appending. The authority on order is the Kafka topic itself — see "The queue is the ordering authority" below — so nothing here needs to sort, buffer, or reconcile before publishing.
- **Minimal processor code.** `examples/events/src/processor.ts` is the whole worker — subscribe, parse the Debezium envelope, transform, `POST`. Kafka/Debezium do ordering, persistence, backpressure, consumer-group management, and at-least-once delivery; the worker's only job is the fold plus the write.

Because Debezium's message is **double-encoded JSON** (the `after` field is a JSON string, not an object) and its shape differs slightly between API-created documents (`{_id, id, payload: {...}}`) and manually-inserted ones (`{_id, name, ...}`), a real worker has to parse defensively — see `examples/events/README.md`'s "Debezium Message Structure" section and the parsing code in `processor.ts` for the exact shape to expect. Don't assume a clean, single-encoded event object.

**If an event meshlette's primary store is `merkql` (via the Rust connector+worker sidecar — see `merkql-architecture`), none of the above applies to that entity at all.** merkql is itself a log; a restlette write against it already is the log append, not something a Debezium-style bridge needs to derive afterward. The Debezium/Kafka pattern above is for entities whose primary store is a real database (Mongo, Postgres) that isn't itself a log. Don't assume merkql needs the same bridging machinery — check whether `meshql-merkql`'s direct `Repository`/`Searcher` is available in the Rust sidecar before concluding merkql can't be used for a given event entity.

## The queue is the ordering authority

**Ordering is provided implicitly. You do not have to build it.** Events arrive at N event meshlettes; the Kafka topics provide the ultimate ordering; workers receive those events in a defined order and are presented with a predictable domain. **Nothing needs to arrive pre-sorted — the append to the topic is what defines the order.** (This is the same point the "Minimal processor code" bullet above makes in passing — Kafka does ordering — stated as the guarantee it is.)

This is the single most reliably reinvented part of the platform. Do not build machinery to reconstruct a total order before publishing. Two separate builds recently did exactly that:

- one derived a cursor from a storage engine's physical row id (`_id INTEGER PRIMARY KEY`) and pinned itself to SQLite to get it — see `references/storage-adapters.md`, "Don't reach underneath the abstraction";
- the other funnelled every entity through a **single-partition** topic sorted by `(created_at, table, _id)`, with a parking buffer to hold events that arrived out of that order.

Both solved a problem Kafka had already solved, and each paid for it: the first with engine portability, the second with throughput plus a buffer that is now a piece of stateful infrastructure someone has to reason about on restart.

If you find yourself writing a comparator, a re-sequencer, or a hold-back buffer on the produce side, stop: the correct amount of ordering code above the queue is none.

## Ordering versus throughput versus durability is queue configuration — and it belongs to the domain

meshql deliberately does not choose between them for you. It **cannot**: it does not know what matters about your domain, and there is no defensible default.

- **If causal order matters**, configure the queue for it. **Partitioning by aggregate id** — a KafkaJS message `key` of the aggregate's id rather than leaving it null and round-robining — keeps causally-related events (a note and the likes on it; an asset and its lifecycle transitions) in one partition, and therefore ordered, without serialising the whole deployment through a single partition. That is usually the right answer, and it is a configuration decision, not a component you write.
- **If throughput or durability matter more**, configure for those instead — more partitions, different `acks`/replication factor, different retention — and accept the weaker cross-aggregate ordering that comes with it.

Whatever you choose, **write down in the architecture document what you prioritised and what you gave up.** It is a domain decision, so it belongs where the domain is described — next to the event storm artifact — not implied by a partition count in a `docker-compose.yml` or `debezium/application.properties` that nobody reads as a design statement. A reader six months later must be able to tell the difference between "we chose per-aggregate order over throughput" and "nobody thought about it." Retention deserves the same treatment here specifically, because — as the replay section below notes — a meshobj deployment's replay window is bounded by Kafka retention, not by an unbounded local log.

## A refused command is a domain object, not an error response

Events are events. If a user tries to put an aggregate into an illegal state, **then that is what they did**, and it is recorded in that event meshlette forever. You do not get to un-happen it, and a check that refuses the write at the door throws away the fact that someone tried.

It is the **worker's** responsibility to find those state errors and respond accordingly — by emitting a **rejection** into its own projection. A rejection carries:

- a link to the aggregate it concerns,
- the source event id, the actor, and the timestamp,
- what was attempted, and why the domain refused it.

Because it is an ordinary projection entity — its own mesh, its own restlette the worker `POST`s to, its own graphlette — it is queryable by clients through the ordinary read path, so a UI can show *"your assignment was refused because the asset is disposed"* instead of leaving the user with a write that appeared to succeed. Think of it as a sophisticated, client-accessible dead-letter queue rather than a `console.warn`.

It recurses cleanly: triaging a rejection is itself an event (`*_acknowledged`) folded into the same projection, so the queue gets worked without anything being mutated in place. **Correction is a new event, all the way down.**

### The consequence for admission checks

A gate in front of the event restlettes — AJV validation, auth middleware — refuses only what is refusable **without domain state**:

- **authorization** — may this caller write this kind of event at all (`CasbinAuth`, `authorized_tokens`);
- **schema validity** — does the payload match the entity's JSON Schema (`core/restlette/src/validation.ts`);
- **create-only** — an event mesh takes `POST` and nothing else.

Anything that needs the aggregate's *current state* — is this asset already disposed, is this account closed, does this holder still exist — is the **worker's** job, and it produces a rejection object, not a 4xx. AJV sees only the payload against a static schema; if you find yourself wanting to query a graphlette from inside a validation hook or an Express middleware in front of a restlette, you have found the boundary.

Note that `teamchat` (a sibling product on the Rust port) currently does stateful checks at admission: its `write_gate` reads channel affiliation and returns 403. That is a defensible choice for chat, where immediate feedback while someone is typing matters more than it does in an asset register, and where a refusal has little downstream meaning worth querying later. But it is a **deliberate divergence** from the pattern above, and it should be named as one in that product's architecture document rather than copied into the next build because it was the shape that happened to be lying around.

## The worker

A worker is an independent Node process — not part of the meshql server, started and scaled separately (`examples/events/src/index.ts` starts the meshql server and the processor together for the example, but in production they're typically separate deployments). Its loop:

1. **Consume** business events from the Kafka topic (`kafkajs`, a fresh consumer group id per run in the example — `groupId: 'events-e2e-processor-'${Date.now()}` — so restarts don't inherit stale offsets; a production worker should usually use a *stable* group id so it resumes from its last committed offset instead of always replaying from the beginning).
2. **Transform/fold** the event into the shape the projection's JSON Schema expects.
3. **Write** the projection via `POST` to its restlette — a normal create, going through the same validation every other client of that entity goes through.

Because the source of truth is the Kafka topic (itself sourced from MongoDB's durable oplog via Debezium), "catch up" and "replay from scratch" are close to the same operation: subscribe `fromBeginning: true` and reprocess. This is what makes a projection safe to drop and rebuild — the worst case is re-deriving state that was already correct.

## Replay: new projections from historical events

Because events are durable in the source collection and mirrored to Kafka, and every meshql read is temporal, **the event mesh is closer to a source of truth than the projection is:**

- **A new projection can be built later from history**, as long as the event topic still has the data (subject to Kafka retention configuration — this is a real operational constraint to plan for, unlike an in-process embedded log with unbounded local retention).
- **A projection can be rebuilt** by pointing a fresh consumer group at the topic from the beginning and replaying — the fix for a worker bug is "correct the fold and replay," not "hand-patch corrupted state."
- **Point-in-time projections** fall out of meshql's temporal reads for free once the projection exists: query `getById(id, at: <past-millis>)` on the projection's own graphlette.

This is only sound as long as retention covers the replay window and nothing bypasses the CDC pipeline — which is exactly why the write-path rule matters even though meshobj doesn't mechanically enforce it.

## Why meshql fits this uniquely well

- **Immutable, versioned Envelopes** = an append-only event record, for free, on every backend.
- **Temporal reads** (`at: Float`) = point-in-time projections, for free, once a projection mesh exists.
- **Per-entity meshes** (own storage, own HOCON block) = events and projections are independently deployable, swappable, and rebuildable.
- **CQRS-by-convention** (REST writes / GraphQL reads) = the event-in / projection-out split is already the grain of the framework. `examples/farm-cqrs/` shows this taken further — a `read-service.conf` and `write-service.conf` splitting the same domain into two deployable services.

## What "idempotent fold" actually guarantees

**Be precise about what "idempotent" means here — the over-reading is dangerous.** A fold is idempotent over a *whole log*: replay the log from an empty projection twice and you get the same noun. That is NOT the same as idempotent *per event*, and most useful folds are not — an accumulator like `messageCount + 1` recomputes correctly from zero and inflates if handed the same event twice against state that already includes it.

A worker that re-reads the log from the beginning every tick never exercises the distinction, because every tick resets and re-folds. **It becomes live the moment a worker consumes incrementally** (committed consumer offsets, a Kafka consumer group resuming where it left off), because at-least-once delivery then means a redelivered batch lands on state that may already include it.

The fix is not to make every fold per-event idempotent — often impossible without storing seen-ids forever. It is to treat **the consumed offset and the fold state as one atomic artifact**: checkpoint them together, restore them together, and commit the offset *after* the projection write. A redelivered batch then lands on the state that predates it and recomputes rather than accumulates. A worker with nowhere durable to keep fold state must also keep no offset — committing a position for in-memory state means restarting at a non-zero offset with an empty projector, which silently produces a wrong noun instead of failing.

Note the checkpoint is generally **not** derivable from the published projection: a projector usually holds state it deliberately never publishes (a pending-request set, an explicitly-granted role, a live-session set). Rehydrating from the projection alone loses exactly that.

## Anti-patterns specific to this pattern

- A front end (or any code outside a worker) `POST`ing directly to a projection's restlette. If you're tempted to write a projection from a UI action, model the underlying business event instead and let the worker derive the projection.
- **Publishing events from application code after a write** (calling out to Kafka from inside a restlette handler, a "save then emit" pattern). That's a dual write with no shared transaction. Events come from CDC (Debezium watching the store), post-commit — never from a code path that also wrote the data.
- Mutating or deleting an event after the fact — correct it with a compensating event instead; the Envelope model doesn't support in-place mutation anyway (invariant 2).
- Computing a domain model on the GraphQL read path (a resolver that joins/aggregates on the fly) instead of materializing it in a worker ahead of time.
- A projection with no worker keeping it in sync by hand.
- Treating a projection as more authoritative than the event log — if they disagree, the log (and the CDC topic, within its retention window) wins and the projection gets rebuilt.
- A worker fold that isn't idempotent (depends on wall-clock reads, randomness, or external state at fold time) — it breaks replay and makes Kafka's at-least-once delivery unsafe to rely on. (Note `buildProcessedEvent` in the example uses `Math.random()` for a fake `processing_time_ms` — fine for a demo metric, but don't let non-determinism leak into fields that affect projection identity or downstream logic.)
- **A worker that commits a consumed offset without durably checkpointing its fold state alongside it.** The two are one decision (see above): committing the offset alone means a restart resumes at a position with an empty projector, silently producing a wrong noun rather than an obvious failure.
- **Machinery to reconstruct a total order before publishing** — a re-sequencer, a parking/hold-back buffer, a single-partition funnel, a physical-row-id cursor. The topic append defines the order; this is code written against a problem that was already solved.
- **A partition/retention/`acks` choice made silently.** Ordering vs throughput vs durability is a domain decision — record in the architecture document what you prioritised and what you gave up.
- **A stateful domain check performed at admission and reported as a 4xx**, discarding the fact that the user tried. Admission refuses only what's refusable without domain state; everything else is a rejection object in a projection, queryable by the client.
