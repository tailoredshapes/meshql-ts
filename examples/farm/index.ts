import * as fs from 'fs';
import * as path from 'path';
import { init, Config } from '@tailoredshapes/meshql-server';
import { MongoPlugin } from '@tailoredshapes/meshql-mongo_repo';
import { getLogger } from '@tailoredshapes/meshql-common';
import { mountManifestRoute } from './manifest';
import { buildRestletteAuthOverrides } from './auth';
const parser = require('@pushcorn/hocon-parser');

const log = getLogger('meshql-ts/farm-example');

async function main() {
    const configDir = path.resolve(__dirname, 'config');
    const configFile = path.join(configDir, 'config.conf');
    const config: Config = await parser.parse({ url: configFile });

    const restletteAuthOverrides = await buildRestletteAuthOverrides(configDir);
    const app = await init(config, { mongo: new MongoPlugin() }, restletteAuthOverrides);

    const manifestPath = path.join(configDir, 'manifest.json');
    const manifestJson = fs.readFileSync(manifestPath, 'utf8');
    mountManifestRoute(app, manifestJson);

    await app.listen(config.port);
    log.info(`Farm example running on port ${config.port} — manifest at /manifest`);
}

main().catch((err) => {
    log.error('Failed to start farm example:', err);
    process.exit(1);
});
