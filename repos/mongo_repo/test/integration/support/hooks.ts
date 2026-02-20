import { Before, After, AfterAll, BeforeAll } from '@cucumber/cucumber';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { compile } from 'handlebars';
import Log4js from 'log4js';
import { IntegrationWorld, SearcherTestTemplates } from '@tailoredshapes/meshql-cert';
import { MongoConfig, MongoPlugin } from '../../../src';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { NoOp } from '@tailoredshapes/meshql-auth';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let mongod: MongoMemoryServer;
let test_id: number;
let templates: SearcherTestTemplates;
let plugin: MongoPlugin;

BeforeAll({ timeout: 120000 }, async function(){
    mongod = new MongoMemoryServer();
    await mongod.start();

    test_id = 0;

    templates = {
        findById: compile(`{"id": "{{id}}"}`),
        findByName: compile(`{"payload.name": "{{id}}"}`),
        findAllByType: compile(`{"payload.type": "{{id}}"}`),
        findByNameAndType: compile(`{"payload.name": "{{name}}", "payload.type": "{{type}}"}`),
    };
    plugin = new MongoPlugin();
});

Before(async function(this: IntegrationWorld) {
    let config: MongoConfig = {
        type: "mongo",
        uri: mongod.getUri(),
        collection: `test-${test_id++}`,
        db: "test",
        options: {
            directConnection: true
        }
    }
    this.templates = templates;
    this.config = config;
    this.plugin = plugin;
    this.envelopes = new Map();
    this.timestamps = new Map();
    this.testStartTime = Date.now();
});

AfterAll(async function(){
    await plugin.cleanup();
    await mongod.stop();
});

