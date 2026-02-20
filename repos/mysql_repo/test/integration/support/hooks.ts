import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import { compile } from 'handlebars';
import Log4js from 'log4js';
import { IntegrationWorld, SearcherTestTemplates } from '@tailoredshapes/meshql-cert';
import { MySQLConfig, MySQLPlugin } from '../../../src';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let container: StartedMySqlContainer;
let test_id: number;
let templates: SearcherTestTemplates;
let plugin: MySQLPlugin;

BeforeAll({ timeout: 120000 }, async function(){
    container = await new MySqlContainer().start();

    test_id = 0;

    templates = {
        findById: compile(`id = '{{id}}'`),
        findByName: compile(`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = '{{id}}'`),
        findAllByType: compile(`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.type')) = '{{id}}'`),
        findByNameAndType: compile(`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.type')) = '{{type}}' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = '{{name}}'`),
    };
    plugin = new MySQLPlugin();
});

Before(async function(this: IntegrationWorld) {
    let config: MySQLConfig = {
        type: "mysql",
        host: container.getHost(),
        port: container.getPort(),
        db: container.getDatabase(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        table: `test_${test_id++}`,
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
    await container.stop();
});

