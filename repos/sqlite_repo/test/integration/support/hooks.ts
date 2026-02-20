import { Before, After, AfterAll, BeforeAll } from '@cucumber/cucumber';
import { compile } from 'handlebars';
import Log4js from 'log4js';
import { IntegrationWorld, SearcherTestTemplates } from '@tailoredshapes/meshql-cert';
import { SQLConfig, SQLitePlugin } from '../../../src';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { NoOp } from '@tailoredshapes/meshql-auth';
import fs from 'fs';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let test_id: number;
let templates: SearcherTestTemplates;
let plugin: SQLitePlugin;

BeforeAll({ timeout: 120000 }, async function(){
    test_id = 0;

    templates = {
        findById: compile(`id = '{{id}}'`),
        findByName: compile(`json_extract(payload, '$.name') = '{{id}}'`),
        findAllByType: compile(`json_extract(payload, '$.type') = '{{id}}'`),
        findByNameAndType: compile(`json_extract(payload, '$.type') = '{{type}}' AND json_extract(payload, '$.name') = '{{name}}'`),
    };
    plugin = new SQLitePlugin();
});

Before(async function(this: IntegrationWorld) {
    const dbPath = `/tmp/test_sqlite_${test_id++}.db`;

    // Clean up the file if it exists from a previous run
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
    }

    let config: SQLConfig = {
        type: "sqlite",
        uri: dbPath,
        collection: `test`,
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
});

