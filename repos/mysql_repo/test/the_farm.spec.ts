import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import Log4js from 'log4js';
import { ServerCertificiation } from '@meshobj/certification';
import { describe } from 'vitest';
import { MySQLPlugin } from '../src';
import { config } from './config';
let container: StartedMySqlContainer | null = null;

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

const setup = async () => {
    container = await new MySqlContainer().withUsername('test').withUserPassword('test').withDatabase('test').start();

    process.env.MYSQL_HOST = container.getHost();
    process.env.MYSQL_PORT = container.getMappedPort(3306).toString();
};

const cleanup = async () => {
    if (container) {
        await container.stop({ timeout: 10000 });
    }
};

describe('The Farm', () => {
    ServerCertificiation(setup, { mysql: new MySQLPlugin() }, config);
});
