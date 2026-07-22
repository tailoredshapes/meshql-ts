import * as fs from 'fs';
import * as path from 'path';
import { generate } from '../manifest';

const configDir = path.resolve(__dirname, '../config');
const manifest = generate(configDir);
const outputPath = path.join(configDir, 'manifest.json');

fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${outputPath}`);
