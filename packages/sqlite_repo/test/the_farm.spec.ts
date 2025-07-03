import { ServerCertificiation } from '@meshobj/certification';
import Log4js from 'log4js';
import { describe } from 'vitest';
import { SQLitePlugin } from '../src/';
import { config } from './config';

Log4js.configure({
    appenders: {
        out: {
            type: 'stdout',
        },
    },
    categories: {
        default: { appenders: ['out'], level: 'error' },
    },
});

let setup = async () => { };

let cleanup = async () => {
    const fs = require('fs');
    try {
        fs.unlinkSync('./thefarm.db');
    } catch (err) {
        // Ignore errors if file doesn't exist
    }
};

describe('The Farm', () => {
    ServerCertificiation(setup, { sql: new SQLitePlugin() }, config, cleanup);
});
