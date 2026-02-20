#!/usr/bin/env node
// Main entry point - starts both the MeshQL server and the Kafka processor

import { init } from '@tailoredshapes/meshql-server';
import { configureLogging, getLogger } from '@tailoredshapes/meshql-common';
import { MongoPlugin } from '@tailoredshapes/meshql-mongo_repo';
import { RawToProcessedProcessor } from './processor.js';
import * as path from 'path';
import * as fs from 'fs';

configureLogging('info');
const log = getLogger('events/index');

// Configuration from environment
const port = parseInt(process.env.PORT || '4055');
const mongoUri = process.env.MONGO_URI || 'mongodb://mongodb:27017/events_db?replicaSet=rs0';
const prefix = process.env.PREFIX || 'events';
const env = process.env.ENV || 'development';
const db = `${prefix}_${env}`;

// Load schemas from config files
// __dirname will be dist/src, so go up two levels to get to the project root
const configDir = path.join(__dirname, '../../config');
const eventGraphQLSchema = fs.readFileSync(path.join(configDir, 'graph/event.graphql'), 'utf-8');
const processedEventGraphQLSchema = fs.readFileSync(path.join(configDir, 'graph/processedevent.graphql'), 'utf-8');
const eventJSONSchema = JSON.parse(fs.readFileSync(path.join(configDir, 'json/event.schema.json'), 'utf-8'));
const processedEventJSONSchema = JSON.parse(fs.readFileSync(path.join(configDir, 'json/processedevent.schema.json'), 'utf-8'));

const config = {
  port,
  graphlettes: [
    {
      path: '/event/graph',
      storage: {
        type: 'mongo',
        uri: mongoUri,
        db,
        collection: 'event',
        options: {}
      },
      schema: eventGraphQLSchema,
      rootConfig: {
        singletons: [
          { name: 'getById', query: 'findOne', id: '_id' },
        ],
        vectors: [
          { name: 'getByName', query: 'find' },
        ],
      }
    },
    {
      path: '/processedevent/graph',
      storage: {
        type: 'mongo',
        uri: mongoUri,
        db,
        collection: 'processedevent',
        options: {}
      },
      schema: processedEventGraphQLSchema,
      rootConfig: {
        singletons: [
          { name: 'getById', query: 'findOne', id: '_id' },
        ],
        vectors: [
          { name: 'getByName', query: 'find' },
          { name: 'getByEvent', query: 'find' },
          { name: 'getByRawEventId', query: 'find' },
        ]
      }
    },
  ],
  restlettes: [
    {
      path: '/event/api',
      storage: {
        type: 'mongo',
        uri: mongoUri,
        db,
        collection: 'event',
        options: {}
      },
      schema: eventJSONSchema
    },
    {
      path: '/processedevent/api',
      storage: {
        type: 'mongo',
        uri: mongoUri,
        db,
        collection: 'processedevent',
        options: {}
      },
      schema: processedEventJSONSchema
    },
  ]
};

const plugins = {
  mongo: new MongoPlugin(),
};

async function main() {
  // Start the MeshQL server
  const app = await init(config, plugins);

  app.listen(config.port, () => {
    log.info(`Server running on port ${config.port}`);
  });

  // Start the Kafka processor
  const rawTopic = process.env.RAW_TOPIC || 'events.events_db.raw_events';
  process.env.RAW_TOPIC = rawTopic;
  process.env.KAFKA_BROKER = process.env.KAFKA_BROKER || 'redpanda:9092';
  process.env.PROCESSED_API_BASE = process.env.PROCESSED_API_BASE || `http://localhost:${config.port}/processedevent/api`;

  const processor = new RawToProcessedProcessor();
  await processor.start();
  log.info(`Processor started, consuming from ${rawTopic}`);

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down gracefully');
    await processor.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log.info('SIGINT received, shutting down gracefully');
    await processor.stop();
    process.exit(0);
  });
}

main().catch(err => {
  log.error('Failed to start:', err);
  process.exit(1);
});
