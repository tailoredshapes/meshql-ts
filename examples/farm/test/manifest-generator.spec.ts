import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { generate } from '../manifest';

const configDir = path.resolve(__dirname, '../config');

describe('generate', () => {
    it('produces an entry for every .graphql file', () => {
        const manifest = generate(configDir);

        expect(manifest.meshql).toBe(1);
        expect(manifest.entities.farm).toBeDefined();
        expect(manifest.entities.coop).toBeDefined();
        expect(manifest.entities.hen).toBeDefined();
        expect(manifest.entities.hen_productivity).toBeDefined();
    });

    it('graph surface has path, kind, and inlined schema text', () => {
        const manifest = generate(configDir);
        const farmGraph = manifest.entities.farm.surfaces.graph;

        expect(farmGraph.kind).toBe('graphql');
        expect(farmGraph.path).toBe('/farm/graph');
        expect(typeof farmGraph.schema).toBe('string');
        expect(farmGraph.schema).toContain('type');
    });

    it('api surface has path, kind, and parsed JSON schema', () => {
        const manifest = generate(configDir);
        const farmApi = manifest.entities.farm.surfaces.api;

        expect(farmApi.kind).toBe('rest');
        expect(farmApi.path).toBe('/farm/api');
        expect(typeof farmApi.schema).toBe('object');
    });

    it('top-level surfaces is empty because there is no change feed', () => {
        const manifest = generate(configDir);
        expect(manifest.surfaces).toEqual({});
    });
});
