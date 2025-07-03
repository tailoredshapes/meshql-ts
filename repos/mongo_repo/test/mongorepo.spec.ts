import { Repository, Envelope } from '@meshobj/common';
import { RepositoryCertification } from '@meshobj/certification';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoRepository } from '../src/mongoRepo';
import { Collection, MongoClient } from 'mongodb';
import { describe, beforeEach, afterAll, it, expect } from 'vitest';

let mongod: MongoMemoryServer;
const mongos: MongoClient[] = [];

const createRepository = async (): Promise<Repository> => {
    if (!mongod) {
        mongod = await MongoMemoryServer.create();
    }

    let client: MongoClient = new MongoClient(mongod.getUri());
    await client.connect();
    mongos.push(client);
    let db = client.db('test');
    let collection: Collection<Envelope> = db.collection(crypto.randomUUID());

    return new MongoRepository(collection);
};

const tearDown = async (): Promise<void> => {
    await Promise.all(
        mongos.map((client) => {
            client.close();
        }),
    );
    if (mongod) {
        await mongod.stop();
    }
};

describe('Mongo Repo', () => {
    RepositoryCertification(createRepository, tearDown, { describe, it, beforeEach, afterAll, expect });
});