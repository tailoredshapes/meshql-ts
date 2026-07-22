import * as fs from 'fs';
import * as path from 'path';
import { init, Config } from '@tailoredshapes/meshql-server';
import { MongoPlugin } from '@tailoredshapes/meshql-mongo_repo';
import { mountManifestRoute } from './manifest';
const parser = require('@pushcorn/hocon-parser');

async function main() {
    const configFile = path.resolve(__dirname, 'config/config.conf');
    const config: Config = await parser.parse({ url: configFile });

    const app = await init(config, { mongo: new MongoPlugin() });

    const manifestPath = path.resolve(__dirname, 'config/manifest.json');
    const manifestJson = fs.readFileSync(manifestPath, 'utf8');
    mountManifestRoute(app, manifestJson);

    await app.listen(config.port);
    console.log(`Farm example running on port ${config.port} — manifest at /manifest`);
}

main().catch((err) => {
    console.error('Failed to start farm example:', err);
    process.exit(1);
});
