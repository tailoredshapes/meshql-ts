# Events Example: CDC-Powered Event Processing Pipeline

This example demonstrates how to build a **trivial yet performant** event processing pipeline using Change Data Capture (CDC) infrastructure. It showcases how adding a "processor" to an event-driven architecture requires minimal code while leveraging proven CDC technology (Debezium + Kafka/Redpanda).

## What We're Demonstrating

The key insight: **You don't need to build event processing infrastructure from scratch.** By using CDC, you can:

1. Write events to MongoDB using a simple REST API
2. Automatically stream changes to Kafka via Debezium
3. Process events with minimal custom code
4. Stream processed results back through the same CDC pipeline
5. Query both raw and processed events via GraphQL

**The processor itself is ~100 lines of code.** All the heavy lifting (reliability, ordering, backpressure, monitoring) is handled by battle-tested CDC infrastructure.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Event Processing Flow                        │
└─────────────────────────────────────────────────────────────────────┘

1. Write Event (REST API)
   Client → POST /event/api → MongoDB (raw_events collection)
                                  │
                                  ├─ GraphQL: /event/graph
                                  │
2. CDC Capture (Debezium)         ▼
   Debezium monitors MongoDB → Change Stream → Kafka Topic
                               (rs0 replica set)    (events.events_development.event)
                                                     │
3. Process Event (Custom Processor)                 │
   Kafka Consumer ◄─────────────────────────────────┘
        │
        ├─ Parse Debezium envelope
        ├─ Transform data (enrich, validate, aggregate)
        │
        └─ POST /processedevent/api → MongoDB (processedevent collection)
                                           │
                                           ├─ GraphQL: /processedevent/graph
                                           │
4. CDC Capture (Debezium again)           ▼
   Debezium monitors MongoDB → Change Stream → Kafka Topic
                                                (events.events_development.processedevent)
                                                     │
5. Verify Results                                   │
   Test Consumer ◄──────────────────────────────────┘
   (proves end-to-end CDC pipeline works)
```

## Key Components

### Services

- **MongoDB (Replica Set)**: Stores both raw and processed events
- **Redpanda**: Kafka-compatible message broker (lightweight alternative)
- **Debezium Server**: CDC connector that captures MongoDB changes
- **Events Service**: MeshQL server providing REST + GraphQL APIs
- **Processor**: Custom Node.js consumer that processes events

### APIs

#### REST Endpoints
- `POST /event/api` - Create raw events
- `GET /event/api/:id` - Retrieve raw event
- `POST /processedevent/api` - Create processed events (used by processor)
- `GET /processedevent/api/:id` - Retrieve processed event

#### GraphQL Endpoints
- `/event/graph` - Query raw events
  - `getById(id: ID)` - Single event
  - `getByName(name: String)` - Events by name

- `/processedevent/graph` - Query processed events
  - `getById(id: ID)` - Single processed event
  - `getByName(name: String)` - Processed events by name
  - `getByRawEventId(raw_event_id: String)` - Find processing results

### Data Flow Example

```typescript
// 1. Create a raw event
POST /event/api
{
  "name": "user_login",
  "data": "{\"user_id\":\"user123\",\"username\":\"john_doe\"}",
  "timestamp": "2025-01-15T10:30:00Z",
  "source": "auth_service",
  "version": "1.0"
}

// 2. Debezium captures change → Kafka (automatic)
// Topic: events.events_development.event
// Message: { op: 'c', after: { _id: '...', name: 'user_login', ... } }

// 3. Processor consumes, transforms, and writes (automatic)
// Processor reads from Kafka, processes, then:
POST /processedevent/api
{
  "id": "new-uuid",
  "raw_event_id": "original-event-id",
  "name": "user_login",
  "processed_data": "{\"user_id\":\"user123\",\"enriched\":true}",
  "processed_timestamp": "2025-01-15T10:30:01Z",
  "processing_time_ms": 42,
  "status": "SUCCESS"
}

// 4. Debezium captures processed event → Kafka (automatic)
// Topic: events.events_development.processedevent

// 5. Query processed results
GET /processedevent/graph
{
  getByRawEventId(raw_event_id: "original-event-id") {
    id
    name
    status
    processing_time_ms
  }
}
```

## Why This Approach is Trivial and Performant

### Trivial (Low Complexity)

1. **No custom queue management**: Kafka handles all the hard parts
   - Message ordering
   - Persistence
   - Backpressure
   - Consumer groups
   - Offset management

2. **Minimal processor code**: See `src/processor.ts` (~100 lines)
   - Subscribe to Kafka topic
   - Parse Debezium envelope
   - Transform data
   - POST to API

3. **No database polling**: CDC automatically captures changes
   - No need for "processed" flags
   - No need for cron jobs
   - No missing changes

4. **Standard APIs**: Just REST + GraphQL via MeshQL
   - No custom event bus to maintain
   - No special event publishing code
   - Standard HTTP/GraphQL tooling works

### Performant

1. **Kafka is battle-tested**: Handles millions of events/sec
2. **CDC is real-time**: Sub-second latency from write to Kafka
3. **Horizontal scaling**: Add more processor instances trivially
4. **Exactly-once semantics**: Debezium + Kafka provide guarantees
5. **Asynchronous**: Writing event returns immediately, processing happens in background

## Quick Start

```bash
# 1. Install and build
cd /tank/repos/meshql-ts  # Or your monorepo root
yarn install
yarn build

# 2. Start the services
cd examples/events/generated
docker-compose up --build

# Wait ~60 seconds for all services to initialize
# You'll see: "Snapshot completed" and "Streaming started" in logs

# 3. Test the pipeline
# In another terminal:
curl -X POST http://localhost:4055/event/api \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test_event",
    "data": "{\"test\":true}",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "source": "quickstart",
    "version": "1.0"
  }'

# 4. Verify processing (wait 3-5 seconds)
curl -X POST http://localhost:4055/processedevent/graph \
  -H "Content-Type: application/json" \
  -d '{"query": "{ getByName(name: \"test_event\") { id status processing_time_ms } }"}'
```

## Setup and Usage

### Prerequisites

- Docker and Docker Compose
- Node.js 20+
- Yarn

### Running the Example

```bash
# From the monorepo root
yarn install
yarn build

# Start the services
cd examples/events/generated
docker-compose up --build

# Services will be available at:
# - Events API: http://localhost:4055
# - GraphQL: http://localhost:4055/event/graph, http://localhost:4055/processedevent/graph
# - REST API docs: http://localhost:4055/event/api/api-docs/swagger.json
# - Kafka: localhost:9092 (use rpk or kafkacat to inspect)
```

**Note**: MongoDB port (27017) is not exposed to avoid port conflicts. Services communicate via Docker network.

### Running the Tests

The BDD integration tests prove the entire CDC pipeline works end-to-end:

1. Starting all services (MongoDB, Kafka, Zookeeper, Debezium, Events service, Processor)
2. Pre-creating collections and topics via init containers
3. Running 4 test scenarios:
   - Scenario 1: Event service produces to Kafka
   - Scenario 2: Processed event service receives messages
   - Scenario 3: Processor consumes from Kafka and calls API
   - Scenario 4: Full end-to-end flow

```bash
# From examples/events
yarn test

# Or from monorepo root (runs all tests sequentially)
yarn test
```

**Test execution notes**:
- Tests run sequentially (not in parallel) to avoid Docker port conflicts
- First test takes ~60 seconds (container startup + CDC initialization)
- Subsequent scenarios are faster (~3-5 seconds each)
- Uses testcontainers for complete isolation and reproducibility

**CI Behavior**:
- Integration tests are automatically skipped in CI environments (when `CI=true`)
- This prevents failures on systems without Docker and speeds up CI pipelines
- To run locally: `yarn test` (tests will run normally)
- To force-skip locally: `CI=true yarn test`
- To force-run in CI: `CI=false yarn test` (requires Docker setup in CI)

## Implementation Details & Lessons Learned

This section documents key implementation details and solutions to common issues encountered when building this CDC pipeline.

### MongoDB Replica Set Initialization

**Challenge**: MongoDB CDC requires a replica set, but initializing it reliably in Docker is tricky.

**Solution**: Use an init container that:
1. Waits for MongoDB to be healthy
2. Checks if replica set is already initialized (idempotent)
3. Initializes with the Docker network hostname (`mongodb:27017`)
4. Waits for PRIMARY status before proceeding

```yaml
mongo-init-replica:
  image: mongo:8
  depends_on:
    mongodb:
      condition: service_healthy
  command: >
    bash -c "
      if mongosh --host mongodb:27017 --eval 'rs.status()' --quiet 2>&1 | grep -q 'no replset config has been received'; then
        mongosh --host mongodb:27017 --eval 'rs.initiate({_id: \"rs0\", members: [{_id: 0, host: \"mongodb:27017\"}]})'
        # Wait for PRIMARY status...
      fi
    "
  restart: 'no'
```

### Pre-creating Collections and Topics

**Challenge**: Debezium won't monitor collections that don't exist yet, and Kafka topics need to exist before consumers subscribe.

**Solution**: Add init containers to create resources before Debezium starts:

```yaml
# In mongo-init-replica command
mongosh --host mongodb:27017 events_development --eval '
  db.event.insertOne({name: "_init", ...});
  db.processedevent.insertOne({id: "00000000-...", ...});
'

# In kafka-init
kafka-topics --bootstrap-server kafka:9093 --create --if-not-exists \
  --topic events.events_development.event --partitions 1 --replication-factor 1
```

**Important**: Empty collections don't persist in MongoDB! You must insert at least one document.

### Debezium Message Structure

**Challenge**: Understanding how to parse Debezium's CDC messages.

Debezium wraps MongoDB documents in an envelope structure:

```json
{
  "payload": {
    "op": "c",  // operation: c=create, u=update, d=delete
    "after": "{\"_id\":{\"$oid\":\"...\"},\"id\":\"uuid\",\"payload\":{\"name\":\"event_name\",\"data\":\"...\"}}"
  }
}
```

**Key insights**:
1. The `after` field is a **JSON string**, not an object - you must parse it twice
2. API-created events have structure: `{ _id, id, payload: {name, data, ...} }`
3. Manually-inserted events have structure: `{ _id, name, data, ... }`
4. The UUID (`id`) and MongoDB ObjectId (`_id`) are both in the root document

**Processor parsing code**:

```typescript
// Parse the Kafka message
const value = JSON.parse(message.value?.toString('utf8') || '{}');

// Extract the 'after' document (handles both config options)
const afterString = value?.payload?.after || value?.after || value;
const afterDoc = typeof afterString === 'string' ? JSON.parse(afterString) : afterString;

// Get IDs from root, data from payload if it exists
const docId = afterDoc?._id;      // MongoDB ObjectId
const docUuid = afterDoc?.id;     // UUID (API-created)
const doc = afterDoc?.payload || afterDoc;  // Event data

// Prioritize UUID for schema compliance
let raw_event_id = docUuid || doc?.id || docId?.$oid || String(docId);
```

### Docker Networking Configuration

**Challenge**: Services need to communicate both with each other and with the host (for tests).

**Solution**:
- MongoDB: No port exposure needed (services use `mongodb:27017` internally)
- Kafka: Expose port 9092 for host access, but configure dual listeners:
  ```
  KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:9093,EXTERNAL://localhost:9092
  KAFKA_LISTENERS: INTERNAL://0.0.0.0:9093,EXTERNAL://0.0.0.0:9092
  ```
- Services use `kafka:9093` internally, tests use `localhost:9092`

### Processor Implementation Details

The processor (`src/processor.ts`) handles several edge cases:

1. **Dynamic group ID**: Uses timestamp to ensure fresh consumer group on restart
   ```typescript
   const consumer = kafka.consumer({ groupId: `events-e2e-processor-${Date.now()}` });
   ```

2. **Filtering noise**: Skips documents without a `name` field to avoid processing init documents
   ```typescript
   if (!doc.name) {
       log.info(`Skipping document without name field`);
       return;
   }
   ```

3. **Data parsing**: Handles both JSON strings and objects in the `data` field
   ```typescript
   let dataObj = typeof doc?.data === 'string' ? JSON.parse(doc.data) : (doc?.data ?? {});
   ```

4. **Environment variables**:
   - `KAFKA_BROKER`: Kafka connection (`kafka:9093` in Docker)
   - `RAW_TOPIC`: Topic to consume from
   - `PROCESSED_API_BASE`: Where to POST results (`http://events:4055/processedevent/api`)

### Testing Strategy

**Integration Tests** (`test/events.bdd.ts`):
- Use testcontainers to start full docker-compose stack
- Wait for all services to be ready (45s setup time)
- Pre-create collections and topics via init containers
- Run 4 BDD scenarios:
  1. Event service produces to Kafka
  2. Processed event service publishes to Kafka
  3. Processor consumes and creates processed events
  4. Full end-to-end flow

**Key testing insights**:
1. **Sequential execution required**: Tests must run one at a time to avoid port conflicts
   ```typescript
   // vitest.config.ts
   fileParallelism: false
   ```

2. **Consumer disconnect pattern**: Must resolve promise before disconnecting
   ```typescript
   resolve();  // First resolve
   consumer.disconnect().catch(() => {});  // Then disconnect without await
   ```

3. **Extended timeouts**: CDC pipeline needs time to initialize (30-45s for first message)

4. **Read from beginning**: Always subscribe with `fromBeginning: true` to catch test messages

### Troubleshooting Common Issues

#### 1. "Debezium monitoring 0 collections"

**Cause**: Collections don't exist when Debezium starts, or `database.include.list` not set.

**Fix**:
```properties
# debezium/application.properties
debezium.source.database.include.list=events_development
```
And ensure collections are pre-created with actual documents (not just created empty).

#### 2. "Connection error" when connecting to Kafka

**Cause**: Kafka port binding takes time after container reports "started".

**Fix**: Add wait time after Kafka starts:
```typescript
await kafkaContainer.start();
await new Promise(resolve => setTimeout(resolve, 10000));  // Wait for port binding
```

#### 3. "Invalid document" errors (400 status)

**Cause**: Schema mismatch - `raw_event_id` expects UUID format but receiving MongoDB ObjectId.

**Fix**: Prioritize UUID extraction:
```typescript
let raw_event_id = docUuid || doc?.id || docId?.$oid;
```

#### 4. "Port already allocated" in tests

**Cause**: Multiple tests trying to bind to same ports (27017, 9092) in parallel.

**Fix**:
- Remove MongoDB port exposure from docker-compose (not needed)
- Run tests sequentially with `fileParallelism: false`
- Use `--poolOptions.threads.singleThread` for workspace-level sequential execution

#### 5. Test times out despite finding messages

**Cause**: Consumer disconnect blocking promise resolution.

**Fix**: Resolve first, then disconnect:
```typescript
receivedEvent = eventData;
clearTimeout(timeout);
resolve();  // ✓ Resolve first
consumer.disconnect().catch(() => {});  // Then disconnect
```

#### 6. ESLint errors on deploy.ts

**Cause**: File excluded from tsconfig but ESLint tries to parse it.

**Fix**: Include the file in tsconfig:
```json
{
  "rootDir": ".",
  "include": ["src/**/*.ts", "deploy.ts"]
}
```

### Performance Characteristics

Based on testing with the full CDC pipeline:

- **Write latency**: < 10ms (MongoDB insert)
- **CDC latency**: 1-3 seconds (MongoDB → Debezium → Kafka)
- **Processing latency**: < 100ms (Kafka → Processor → API → MongoDB)
- **End-to-end latency**: 3-5 seconds (raw event → processed event in Kafka)
- **Consumer group join time**: ~3 seconds

The bottleneck is CDC capture time (waiting for MongoDB change stream), not the processor itself.

### Debezium Configuration Deep Dive

Key settings in `debezium/application.properties`:

```properties
# Monitor specific database (will capture ALL collections in this database)
debezium.source.database.include.list=events_development

# Simplify message format - return full document instead of diff
debezium.source.publish.full.document.only=true

# Use change streams (required for MongoDB)
debezium.source.capture.mode=change_streams

# Topic naming: {prefix}.{database}.{collection}
debezium.source.topic.prefix=events
# Results in: events.events_development.event

# Kafka sink configuration
debezium.sink.type=kafka
debezium.sink.kafka.producer.bootstrap.servers=kafka:9093

# File-based offset storage for development
debezium.source.offset.storage=org.apache.kafka.connect.storage.FileOffsetBackingStore
debezium.source.offset.storage.file.filename=/tmp/offsets.dat
```

**Production considerations**:
- Use `debezium.source.offset.storage=org.apache.kafka.connect.storage.KafkaOffsetBackingStore` instead of file-based
- Set `debezium.source.collection.include.list` for fine-grained control
- Configure `debezium.source.skipped.operations` to filter unnecessary events
- Add `debezium.transforms` for message transformation

## Configuration Files

### `debezium/application.properties`

Configures Debezium Server to:
- Monitor MongoDB replica set `rs0`
- Watch collections: `events_development.event` and `events_development.processedevent`
- Publish changes to Redpanda topics
- Use file-based offset storage for development

Key settings:
```properties
debezium.source.connector.class=io.debezium.connector.mongodb.MongoDbConnector
debezium.source.mongodb.connection.string=mongodb://mongodb:27017/?replicaSet=rs0
debezium.source.database.include.list=events_development
debezium.source.collection.include.list=events_development.event,events_development.processedevent
debezium.sink.type=kafka
debezium.sink.kafka.producer.bootstrap.servers=redpanda:9092
```

### `generated/docker-compose.yml`

Orchestrates all services with proper health checks and dependencies:

1. **MongoDB**: Started first with replica set
2. **mongo-init-replica**: Initializes replica set (required for CDC)
3. **Redpanda**: Kafka-compatible broker
4. **Debezium**: Starts after MongoDB replica set is ready
5. **Events Service**: Starts after all dependencies are healthy

### `src/index.ts`

Main entry point that:
- Initializes MeshQL server with graphlettes and restlettes
- Starts the Kafka processor
- Handles graceful shutdown

### `src/processor.ts`

The event processor that:
- Consumes from `events.events_development.event` topic
- Filters for insert/create operations
- Extracts the `after` document from Debezium envelope
- Transforms/enriches the data
- Posts processed event to `/processedevent/api`

## Comparison with Traditional Approaches

### Without CDC

```typescript
// Traditional approach: Manual event publishing
async function createEvent(event) {
  // 1. Write to database
  const saved = await db.events.insert(event);

  // 2. Publish to queue (easy to forget, can fail silently)
  await queue.publish('raw-events', saved);

  // 3. What if queue publish fails? Need retry logic, dead letter queues...
  // 4. What if there's a bug and some code path doesn't publish?
  // 5. What about backfilling? Need separate scripts...
}
```

Problems:
- Dual-write problem (database + queue can get out of sync)
- Easy to forget to publish in some code paths
- Complex error handling
- Backfilling is painful

### With CDC

```typescript
// CDC approach: Just write to database
async function createEvent(event) {
  // 1. Write to database
  const saved = await db.events.insert(event);

  // That's it! Debezium automatically publishes to Kafka
  // - No dual-write problem
  // - Can't forget to publish
  // - Backfilling is just replaying the change stream
}
```

Benefits:
- Single write operation
- Automatic, reliable event publishing
- Guaranteed consistency
- Easy backfilling and replay

## Extending the Example

### Adding More Processors

Create additional consumers for different processing needs:

```typescript
// Add a validation processor
const validationConsumer = kafka.consumer({ groupId: 'validation-processor' });
await validationConsumer.subscribe({ topic: 'events.events_development.event' });

// Add an analytics processor
const analyticsConsumer = kafka.consumer({ groupId: 'analytics-processor' });
await analyticsConsumer.subscribe({ topic: 'events.events_development.event' });
```

Each consumer group processes independently - Kafka handles fan-out automatically.

### Scaling Horizontally

Run multiple instances of the processor:

```bash
# Terminal 1
node dist/index.js

# Terminal 2
node dist/index.js

# Terminal 3
node dist/index.js
```

Kafka automatically distributes partitions across consumer group members.

### Adding More Event Types

Just add new fields to your events - no infrastructure changes needed:

```typescript
// New event type
POST /event/api
{
  "name": "user_logout",
  "data": "{\"user_id\":\"user123\",\"session_duration_ms\":3600000}",
  "timestamp": "2025-01-15T11:30:00Z",
  "source": "auth_service",
  "version": "1.0"
}
```

The processor can handle different event types with a simple switch statement.

## Production Considerations

This example uses simplified settings for demonstration. For production:

1. **MongoDB**:
   - Use proper replica set with multiple nodes
   - Configure authentication
   - Set up backups

2. **Kafka/Redpanda**:
   - Use a proper cluster (3+ nodes)
   - Configure retention policies
   - Set up monitoring (Prometheus/Grafana)

3. **Debezium**:
   - Use Kafka Connect cluster instead of Debezium Server
   - Configure proper offset storage (Kafka topics, not files)
   - Set up alerting for connector failures

4. **Processor**:
   - Add proper error handling and dead letter queues
   - Implement retries with exponential backoff
   - Add metrics and tracing
   - Use consumer group management for scaling

5. **Security**:
   - Enable TLS for all connections
   - Configure SASL authentication for Kafka
   - Use network policies to restrict access
   - Implement API authentication/authorization

## Performance Testing

Want to see how fast this CDC pipeline can go? Check out the performance tests!

```bash
# Start the services
cd generated
docker-compose up -d

# Wait ~60 seconds for initialization, then run performance tests
cd ..
yarn perf
```

The performance tests use JMeter to measure:
- **Event creation throughput**: How many events/sec can you write?
- **API latency**: p50, p90, p99 response times
- **CDC end-to-end latency**: Track events through both Kafka topics in real-time
- **System behavior under load**: Does it stay stable?

### Measuring CDC Pipeline Latency

The new `cdc-pipeline-latency.jmx` test gives you real-time visibility into events flowing through the pipeline:

```bash
# Run in JMeter GUI to watch events flow through Kafka
jmeter -t performance/test-plans/cdc-pipeline-latency.jmx
```

Watch events progress through:
1. **POST Event** - API creates event
2. **Raw Events Topic** - Debezium captures MongoDB change
3. **Processor** - Consumes, transforms, writes processed event
4. **Processed Events Topic** - Debezium captures processed event

This shows you the **actual latency** users experience, not just API response time.

Expected baseline performance (dev hardware):
- **Throughput**: 100-300 events/sec (single instance)
- **Write latency**: 20-40ms average, < 100ms p99
- **CDC latency**: 1-3 seconds (MongoDB → Kafka)
- **End-to-end**: 3-5 seconds (write → processed event appears)

See [`performance/README.md`](performance/README.md) for:
- How to run tests
- Installing JMeter Kafka plugin
- Interpreting results
- Creating custom test plans
- Understanding CDC-specific latency characteristics
- Production performance expectations

**TL;DR**: The API writes are blazingly fast (< 50ms). The CDC pipeline adds 1-3 seconds of latency, but that's the trade-off for zero-code event publishing, guaranteed delivery, and horizontal scalability.

## Monitoring and Debugging

### Check Kafka Topics

```bash
# List topics
docker exec -it redpanda rpk topic list

# Consume messages from raw events topic
docker exec -it redpanda rpk topic consume events.events_development.event

# Consume messages from processed events topic
docker exec -it redpanda rpk topic consume events.events_development.processedevent
```

### Check MongoDB Collections

```bash
# Connect to MongoDB
docker exec -it mongodb mongosh

# Use the database
use events_development

# Check raw events
db.event.find().pretty()

# Check processed events
db.processedevent.find().pretty()
```

### Check Debezium Logs

```bash
docker logs debezium -f
```

Look for:
- "Snapshot completed"
- "Streaming started"
- Error messages if connector fails

### Test GraphQL Queries

```bash
# Query raw events
curl -X POST http://localhost:4055/event/graph \
  -H "Content-Type: application/json" \
  -d '{"query": "{ getByName(name: \"user_login\") { id name source timestamp } }"}'

# Query processed events
curl -X POST http://localhost:4055/processedevent/graph \
  -H "Content-Type: application/json" \
  -d '{"query": "{ getByName(name: \"user_login\") { id status processing_time_ms } }"}'
```

## Key Takeaways

1. **CDC makes event processing trivial**: No need to build custom event publishing infrastructure
2. **Battle-tested technology**: Debezium and Kafka are proven at massive scale
3. **Minimal code**: The processor is ~100 lines, everything else is configuration
4. **Reliable by default**: Exactly-once semantics, automatic retry, proper ordering
5. **Easy to extend**: Add more processors, event types, or processing steps without infrastructure changes
6. **Standard tooling**: REST + GraphQL + Kafka - use familiar tools and libraries

This pattern is particularly valuable when:
- You need reliable event processing without building custom infrastructure
- You want to add event-driven features to an existing database-backed application
- You need to scale event processing independently of your main application
- You want to support multiple consumers of the same events (analytics, validation, notifications, etc.)

## Summary: What Makes This Work

After building and debugging this CDC pipeline, here are the critical pieces that make it reliable:

### Infrastructure Setup (90% of the work)
1. **MongoDB replica set**: Properly initialized with correct hostnames for Docker networking
2. **Pre-created resources**: Collections and topics exist before Debezium starts monitoring
3. **Init containers**: Ensure dependencies are ready before dependent services start
4. **Health checks**: Each service reports when it's truly ready (not just running)
5. **Docker networking**: Services use internal hostnames (`kafka:9093`), tests use exposed ports

### Message Parsing (The Tricky Part)
The Debezium message format is the most non-obvious aspect:
- Messages are **double-encoded JSON** (string within a string)
- UUIDs and ObjectIds both present - need to handle both formats
- Payload structure differs between API-created and manually-inserted documents
- The processor must parse defensively to handle all variations

### Testing (Requires Patience)
- CDC pipelines take 30-60 seconds to initialize on first run
- Consumer groups take ~3 seconds to join and get assigned partitions
- Tests must run sequentially to avoid Docker port conflicts
- Promise resolution timing matters (resolve before disconnecting consumers)

### What We Learned
Building a production-ready CDC pipeline requires attention to:
- **Infrastructure orchestration**: Services must start in the right order with proper health checks
- **Message format understanding**: Debezium's envelope structure isn't intuitive
- **Testing strategy**: Integration tests need generous timeouts and sequential execution
- **Docker networking**: Internal vs external ports matter
- **MongoDB specifics**: Replica sets, change streams, collection persistence

The good news: Once it's set up correctly, it's **rock solid**. The CDC infrastructure (Debezium + Kafka) handles all the hard parts - ordering, reliability, retry, backpressure. Your only job is parsing messages and writing business logic.

## License

See monorepo root LICENSE file.
