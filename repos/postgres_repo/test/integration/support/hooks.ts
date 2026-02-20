import { Before, After, AfterAll, BeforeAll } from '@cucumber/cucumber';
import { compile } from 'handlebars';
import Log4js from 'log4js';
import { IntegrationWorld, SearcherTestTemplates } from '@tailoredshapes/meshql-cert';
import { PostgresConfig, PostgresPlugin } from '../../../src';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { NoOp } from '@tailoredshapes/meshql-auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { StartedTestContainer } from 'testcontainers';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let container: StartedTestContainer;
let test_id: number;
let templates: SearcherTestTemplates;
let plugin: PostgresPlugin;

let user = 'bob';
let password = 'max';
let database = 'test';

BeforeAll({ timeout: 120000 }, async function(){
    container = await new PostgreSqlContainer("postgres:17-alpine3.21")
        .withUsername(user)
        .withPassword(password)
        .withDatabase(database)
        .start();

    test_id = 0;

    templates = {
        findById: compile(`id = '{{id}}'`),
        findByName: compile(`payload->>'name' = '{{id}}'`),
        findAllByType: compile(`payload->>'type' = '{{id}}'`),
        findByNameAndType: compile(`payload->>'type' = '{{type}}' AND payload->>'name' = '{{name}}'`),
    };
    plugin = new PostgresPlugin();
});

Before(async function(this: IntegrationWorld) {
    let config: PostgresConfig = {
        type: "postgres",
        host: container.getHost(),
        port: container.getMappedPort(5432),
        db: database,
        user: user,
        password: password,
        table: `test_${test_id++}`,
    };
    this.templates = templates;
    this.config = config;
    this.plugin = plugin;
    this.envelopes = new Map();
    this.timestamps = new Map();
    this.testStartTime = Date.now();
});

AfterAll(async function(){
    await plugin.cleanup();
    await container!.stop();
});

