import { Kafka, logLevel } from 'kafkajs';
import axios from 'axios';
import { getLogger } from '@tailoredshapes/meshql-common';

const log = getLogger('events/processor');

const KAFKA_BROKER = process.env.KAFKA_BROKER ?? 'localhost:9092';
const RAW_TOPIC = process.env.RAW_TOPIC!;
const PROCESSED_API_BASE = process.env.PROCESSED_API_BASE ?? 'http://localhost:4055/processedevent/api';

// Very basic "processing" — enrich + echo some fields
// Expects plain document format from Debezium (publish.full.document.only=true)
function buildProcessedEvent(doc: any, docId?: any, docUuid?: string) {
    // Use the UUID from the document (API-created events have this)
    // Fall back to MongoDB ObjectId for manually-inserted events
    let raw_event_id = '';
    if (docUuid) {
        raw_event_id = docUuid;
    } else if (doc?.id) {
        raw_event_id = String(doc.id);
    } else if (docId?.$oid) {
        raw_event_id = docId.$oid;
    } else if (typeof docId === 'string') {
        raw_event_id = docId;
    }
    const name = String(doc?.name ?? 'unknown');

    // Parse the data field if it's a JSON string
    let dataObj: any = {};
    try {
        if (typeof doc?.data === 'string') {
            dataObj = JSON.parse(doc.data);
        } else {
            dataObj = doc?.data ?? {};
        }
    } catch (e) {
        // If parsing fails, use empty object
        dataObj = {};
    }

    // You declared processed_data as string; stringify here
    const processed_data = JSON.stringify({
        user_id: dataObj?.user_id ?? null,
        username: dataObj?.username ?? null,
        source: doc?.source ?? null,
        enriched: true,
        processed_at: new Date().toISOString()
    });

    return {
        id: crypto.randomUUID(),
        raw_event_id,
        name,
        correlationId: doc?.correlationId,
        processed_data,
        processed_timestamp: new Date().toISOString(),
        processing_time_ms: Math.round(Math.random() * 10) + 5,
        status: 'SUCCESS' as const
    };
}

export class RawToProcessedProcessor {
    private kafka = new Kafka({
        clientId: 'events-e2e-processor',
        brokers: [KAFKA_BROKER],
        logLevel: logLevel.NOTHING
    });

    private running = false;

    async start() {
        if (this.running) return;
        this.running = true;

        log.info(`Starting processor: KAFKA_BROKER=${KAFKA_BROKER}, RAW_TOPIC=${RAW_TOPIC}, PROCESSED_API_BASE=${PROCESSED_API_BASE}`);

        const consumer = this.kafka.consumer({ groupId: `events-e2e-processor-${Date.now()}` });
        await consumer.connect();
        log.info(`Consumer connected, subscribing to topic: ${RAW_TOPIC}`);
        await consumer.subscribe({ topic: RAW_TOPIC, fromBeginning: true });
        log.info(`Subscribed to ${RAW_TOPIC}, starting consumer...`);

        await consumer.run({
            eachMessage: async ({ message }: { message: any }) => {
                if (!this.running) return;
                try {
                    const text = message.value?.toString('utf8') ?? '{}';
                    const value = JSON.parse(text);

                    log.info(`Received message from Kafka: ${text.substring(0, 200)}`);

                    // Handle Debezium message structure (even with publish.full.document.only=true)
                    const afterString = value?.payload?.after || value?.after || value;
                    const afterDoc = typeof afterString === 'string' ? JSON.parse(afterString) : afterString;

                    // API-created events have structure: { _id, id, payload: {name, data, ...}, ... }
                    // Manually-inserted events have structure: { _id, name, data, ... }
                    // Extract the _id and id from the root document first
                    const docId = afterDoc?._id;
                    const docUuid = afterDoc?.id;

                    // Then get the event data (from payload if it exists, otherwise use the doc itself)
                    const doc = afterDoc?.payload || afterDoc;

                    // Require some "name" to avoid noise
                    if (!doc.name) {
                        log.info(`Skipping document without name field. Doc keys: ${Object.keys(doc || {}).join(', ')}`);
                        return;
                    }

                    const processed = buildProcessedEvent(doc, docId, docUuid);
                    log.info(`Processing event: ${doc.name} (id: ${processed.raw_event_id})`);

                    const response = await axios.post(PROCESSED_API_BASE, processed, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 5000
                    });

                    log.info(`Successfully processed event: ${doc.name} (id: ${processed.raw_event_id}), API response status: ${response.status}`);
                } catch (err) {
                    log.error('Error processing message:', err);
                }
            }
        });

        // keep a reference to allow stop()
        (this as any)._consumer = consumer;
    }

    async stop() {
        this.running = false;
        const consumer = (this as any)._consumer;
        if (consumer) {
            try {
                await consumer.disconnect();
            } catch {
                // Ignore disconnect errors during cleanup
            }
            (this as any)._consumer = undefined;
        }
    }
}