import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Mock, It } from 'moq.ts';
import { buildSchema, graphql } from 'graphql';
import { context } from '../src/graph/root';
import { RootConfig, Searcher } from '@tailoredshapes/meshql-common';
import { Auth } from '@tailoredshapes/meshql-auth';
import fetchMock from 'fetch-mock';

const createdAt = new Date();

const auth = new Mock<Auth>()
    .setup(async (i) => i.getAuthToken(It.IsAny()))
    .returnsAsync(['TOKEN'])
    .setup(async (i) => i.isAuthorized(It.IsAny(), It.IsAny()))
    .returnsAsync(true)
    .object();

describe('GraphQL Configuration', () => {
    describe('Generating a simple root', () => {
        const simple: RootConfig = {
            singletons: [
                {
                    name: 'getById',
                    query: '{"id": "{{id}}"}',
                },
                {
                    name: 'getByFoo',
                    query: '{"payload.foo": "{{foo}}"}',
                },
            ],
        };

        const schema = buildSchema(`
      type Test {
        id: ID
        foo: String
        eggs: Int
      }
      type Query {
        getById(id: String): Test
        getByFoo(foo: String): Test
      }
    `);

        const repo = new Mock<Searcher<string>>()
            .setup(async (i) => i.find(It.IsAny(), It.IsAny(), It.IsAny(), It.IsAny()))
            .returnsAsync({ foo: 'bar', eggs: 6 })
            .object();

        it('should create a simple root', async () => {
            const query = /* GraphQL */ `
                {
                    getById(id: "test_id") {
                        eggs
                    }
                }
            `;

            const { root } = context(repo, auth, simple);

            const response = await graphql({
                schema,
                source: query,
                rootValue: root,
            });

            if (response.errors) {
                console.error(response.errors);
                throw new Error('GraphQL returned errors');
            }

            expect(response.data?.getById?.eggs).toBe(6);
        });
    });

    describe('Generating a simple vector root', () => {
        const vector = {
            singletons: [
                {
                    name: 'getById',
                    query: '{"id": "{{id}}"}',
                },
            ],
            vectors: [
                {
                    name: 'getByBreed',
                    query: '{"payload.breed": "{{breed}}"}',
                },
            ],
        };

        const schema = buildSchema(/* GraphQL */ `
            type Test {
                id: ID
                name: String
                eggs: Int
                breed: String
            }
            type Query {
                getById(id: String): Test
                getByBreed(breed: String): [Test]
            }
        `);

        const repo = new Mock<Searcher<string>>()
            .setup(async (i) => i.findAll(It.IsAny(), It.IsAny(), It.IsAny(), It.IsAny()))
            .returnsAsync([
                { name: 'henry', eggs: 3, breed: 'chicken', id: 'chick_1' },
                { name: 'harry', eggs: 4, breed: 'chicken', id: 'chick_2' },
            ])
            .object();

        it('should create a simple vector root', async () => {
            const query = /* GraphQL */ `
                {
                    getByBreed(breed: "chicken") {
                        id
                        name
                    }
                }
            `;

            const { root } = context(repo, auth, vector);
            const response: any = await graphql({ schema, source: query, rootValue: root });

            if (response.errors) {
                console.error(response.errors);
                throw new Error('GraphQL returned errors');
            }

            const resultNames = response.data?.getByBreed?.map((d: any) => d.name);
            const resultIds = response.data?.getByBreed?.map((d: any) => d.id);

            expect(resultNames).toEqual(expect.arrayContaining(['henry', 'harry']));
            expect(resultIds).toEqual(expect.arrayContaining(['chick_1', 'chick_2']));
        });
    });

    describe('Generating a simple singleton root with a dependency', () => {
        const simple = {
            singletons: [
                {
                    name: 'getById',
                    id: 'id',
                    query: '{"id": "{{id}}"}',
                },
            ],
            resolvers: [
                {
                    name: 'coop',
                    id: 'coop_id',
                    queryName: 'getById',
                    url: 'http://localhost:3000',
                },
            ],
        };

        const schema = buildSchema(/* GraphQL */ `
            type Coop {
                name: String
            }
            type Test {
                id: ID
                name: String
                eggs: Int
                coop: Coop
            }
            type Query {
                getById(id: String): Test
            }
        `);

        const repo = new Mock<Searcher<string>>()
            .setup(async (i) => i.find(It.IsAny(), It.IsAny(), It.IsAny(), It.IsAny()))
            .returnsAsync({
                name: 'chucky',
                eggs: 1,
                coop_id: '101010',
                id: 'chuck',
            })
            .object();

        it('should call the dependency', async () => {
            const url: string = new URL(simple.resolvers[0].url).toString();

            fetchMock.mockGlobal().post(url, {
                data: { getById: { name: 'mega' } },
            });

            const query = /* GraphQL */ `
                {
                    getById(id: "chuck") {
                        id
                        name
                        coop {
                            name
                        }
                    }
                }
            `;

            const { root } = context(repo, auth, simple);
            const response: any = await graphql({ schema, source: query, rootValue: root });

            if (response.errors) {
                console.error(response.errors);
                throw new Error('GraphQL returned errors');
            }

            expect(response.data?.getById?.coop?.name).toBe('mega');
            expect(response.data?.getById?.id).toBe('chuck');
        });
    });
});
