import { Envelope } from '@tailoredshapes/meshql-common';
import { Document, WithId } from 'mongodb';

export type Payload = {
    id: string;
};

export type Schema = WithId<Document> & Envelope;

export type QueryArgs = {
    req: Request;
};
