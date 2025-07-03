import { Envelope, Searcher } from '@meshobj/common';
import { TemplateDelegate } from 'handlebars';
import { Repository } from '@meshobj/common';

export type TestTemplates = {
    findById: TemplateDelegate;
    findByName: TemplateDelegate;
    findAllByType: TemplateDelegate;
    findByNameAndType: TemplateDelegate;
};

export type Testvelope = Envelope & {
    payload: { name: string; count: number; type: 'A' | 'B' };
};

export function SearcherCertification(
    init: () => Promise<{ repository: Repository; searcher: Searcher }>,
    tearDown: () => Promise<void>,
    templates: TestTemplates,
    vitest: { describe: any; it: any; beforeEach: any; afterAll: any; expect: any },
    tokens: string[] = ['TOKEN'],
) {
    const { describe, it, beforeEach, afterAll, expect } = vitest;
    let searcher: Searcher;
    let saved: Envelope[] = [];

    beforeEach(async () => {
        const testData: Testvelope[] = [
            { payload: { name: 'Bruce', count: 1, type: 'A' } },
            { payload: { name: 'Charlie', count: 2, type: 'A' } },
            { payload: { name: 'Danny', count: 3, type: 'A' } },
            { payload: { name: 'Ewan', count: 4, type: 'A' } },
            { payload: { name: 'Fred', count: 5, type: 'B' } },
            { payload: { name: 'Greg', count: 6, type: 'B' } },
            { payload: { name: 'Henry', count: 7, type: 'B' } },
            { payload: { name: 'Ian', count: 8, type: 'B' } },
            { payload: { name: 'Gretchen', count: 9, type: 'B' } },
            { payload: { name: 'Casie', count: 9, type: 'A' } },
        ];

        const { repository, searcher: search } = await init();
        saved = await repository.createMany(testData, tokens);

        const gretchen: Envelope = saved.find((e) => e.payload.name === 'Gretchen')!;
        await repository.remove(gretchen.id!, tokens);

        const cassie = saved.find((e) => e.payload.name === 'Casie')!;
        let updatedCass = { id: cassie.id, tokens: tokens, payload: { name: 'Cassie', count: 10, type: 'A' } };
        await repository.create(updatedCass);
        searcher = search;
    });

    afterAll(async () => {
        await tearDown();
    });

    describe('Searcher Certification Tests', () => {
        it('should return empty result for non-existent ID', async () => {
            const id = 'non-existent-id';

            const result = await searcher.find(templates['findById'], { id });

            expect(result).toEqual({}); // Ensure undefined is returned for invalid ID.
        });

        it('should find by id', async () => {
            const id = saved[0].id!;

            const result = await searcher.find(templates['findById'], { id });

            expect(result.name).toEqual(saved[0].payload.name);
            expect(result.count).toEqual(1);
        });

        it('should find by name', async () => {
            const id = saved[3].payload.name;

            const result = await searcher.find(templates['findByName'], { id });

            expect(result.name).toEqual(saved[3].payload.name);
        });

        it('should find all by type', async () => {
            const id = 'A';

            const result = await searcher.findAll(templates['findAllByType'], { id });

            if (result.length !== 5) {
                console.log('Bad result', JSON.stringify(result, null, 2));
            }
            expect(result.length).toEqual(5);
            let charlie = result.filter((f) => f.name === 'Charlie')[0];
            expect(charlie.count).toEqual(2);
        });

        it('should find all by type and name', async () => {
            const result = await searcher.findAll(templates['findByNameAndType'], {
                id: 'foo',
                name: 'Henry',
                type: 'B',
            });

            expect(result.length).toEqual(1);
            expect(result[0].name).toEqual('Henry');
        });

        it('should return empty array for non-existent type', async () => {
            const id = 'C'; // Type "C" does not exist in the test data.

            const result = await searcher.findAll(templates['findAllByType'], { id });

            expect(result).toEqual([]); // Verify an empty array is returned for no matches.
        });

        it('should handle search with empty query parameters', async () => {
            const result = await searcher.findAll(templates['findByNameAndType'], {});

            expect(result).toEqual([]); // Verify no results for empty query.
        });
    });
} 