#!/usr/bin/env tsx
// deploy.ts - Type-safe deployment configuration for events example

import { Service, Database, Deployment } from '@tailoredshapes/meshql-deploy';
import * as path from 'path';

// MongoDB database - NO directConnection (replica set required for Debezium)
const eventsDB = new Database(
  'mongo',
  'mongodb://mongodb:27017/events_db?replicaSet=rs0',
  'events_db',
  {}  // Empty options to override default directConnection
);

// Single service handling both Event and ProcessedEvent APIs
const eventsService = new Service('events', 4055)
  // Event GraphQL endpoint
  .graphql(
    '/event/graph',
    path.join(__dirname, 'config/graph/event.graphql'),
    eventsDB,
    'event',
    (gql) => gql
      .withVector('getByName', 'find')
      .withSingleton('getById', 'findOne', '_id')
  )
  // ProcessedEvent GraphQL endpoint
  .graphql(
    '/processedevent/graph',
    path.join(__dirname, 'config/graph/processedevent.graphql'),
    eventsDB,
    'processedevent',
    (gql) => gql
      .withVector('getByName', 'find')
      .withSingleton('getById', 'findOne', '_id')
      .withVector('getByEvent', 'find')
  )
  // Event REST endpoint
  .rest(
    '/event/api',
    path.join(__dirname, 'config/json/event.schema.json'),
    eventsDB,
    'event'
  )
  // ProcessedEvent REST endpoint
  .rest(
    '/processedevent/api',
    path.join(__dirname, 'config/json/processedevent.schema.json'),
    eventsDB,
    'processedevent'
  )
  .withEnv('PLATFORM_URL', 'http://localhost:4055');

// Create deployment
const deployment = new Deployment([eventsService], {
  outputDir: path.join(__dirname, 'generated'),
  dockerContext: '../..',
  dockerfile: 'examples/events/Dockerfile',
  mongoImage: 'mongo:8'
});

// Add database
deployment.withDatabase(eventsDB);

// Generate all files
deployment.generate().catch((err) => {
  console.error('Deployment generation failed:', err);
  process.exit(1);
});
