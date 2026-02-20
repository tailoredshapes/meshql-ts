import { Auth } from '@tailoredshapes/meshql-auth';
import Log4js from 'log4js';
import { Envelope, Repository, Validator } from '@tailoredshapes/meshql-common';
import { Request, Response } from 'express';

const logger = Log4js.getLogger('meshql-ts/restlette');

export class Crud {
    private _authorizer: Auth;
    private _repo: Repository;
    private readonly _context: string;
    private readonly _tokens: string[];
    private readonly _validator: Validator;

    constructor(authorizer: Auth, repo: Repository, validator: Validator, context: string, tokens: string[] = []) {
        this._authorizer = authorizer;
        this._repo = repo;
        this._context = context;
        this._tokens = tokens;
        this._validator = validator;
    }

    create = async (req: Request, res: Response) => {
        const authorized_tokens: string[] = await this.calculateTokens(req);
        const payload: Record<string, any> = req.body;

        if (!(await this._validator(payload))) {
            res.status(400).send('Invalid document');
            return;
        }

        const doc: Envelope = { payload, authorized_tokens };
        const result: Envelope = await this._repo.create(doc);

        if (result) {
            logger.debug(`Created: ${JSON.stringify(result)}`);
            res.status(303).location(`${this._context}/${result.id}`).send();
        } else {
            logger.error(`Failed to create: ${JSON.stringify(doc)}`);
            res.status(400).send();
        }
    };

    private async calculateTokens(req: Request): Promise<string[]> {
        return this._tokens.length > 0 ? this._tokens : await this._authorizer.getAuthToken(req);
    }

    read = async (req: Request, res: Response) => {
        const id = req.params.id;
        const authToken = await this._authorizer.getAuthToken(req);
        const result = await this._repo.read(id);

        if (result) {
            res.setHeader('X-Canonical-Id', String(result.id));
            if (await this._authorizer.isAuthorized(authToken, result)) {
                res.send(result.payload);
            } else {
                res.status(403).send({});
            }
        } else {
            res.status(404).send({});
        }
    };

    update = async (req: Request, res: Response) => {
        const id = req.params.id;
        const authToken = await this._authorizer.getAuthToken(req);
        const payload = req.body as any;

        if (!(await this._validator(payload))) {
            res.status(400).send('Invalid document');
            return;
        }

        const envelope: Envelope = {
            id,
            payload,
            authorized_tokens: await this.calculateTokens(req),
        };

        const current = await this._repo.read(id);

        if (current) {
            if (await this._authorizer.isAuthorized(authToken, current)) {
                const result = await this._repo.create(envelope);
                logger.debug(`Updated: ${JSON.stringify(result)}`);
                res.status(303).location(`${this._context}/${result.id}`).send();
            } else {
                res.status(403).send({});
            }
        } else {
            res.status(404).send({});
        }
    };

    remove = async (req: Request, res: Response) => {
        const id = req.params.id;
        const result = await this._repo.read(id);
        const tokens = await this._authorizer.getAuthToken(req);

        if (result) {
            if (await this._authorizer.isAuthorized(tokens, result)) {
                const success = await this._repo.remove(id);
                if (success) {
                    logger.debug(`Deleted: ${id}`);
                    res.send({ deleted: id });
                } else {
                    res.status(404).send({});
                }
            } else {
                res.status(403).send({});
            }
        } else {
            res.status(404).send({});
        }
    };

    list = async (_req: Request, res: Response) => {
        const results = await this._repo.list();
        res.send(results.map((r) => `${this._context}/${r.id}`));
    };

    bulk_create = async (req: Request, res: Response) => {
        const docs: Record<string, any>[] = req.body as Record<string, any>[];
        const authorizedTokens = await this.calculateTokens(req);

        const envelopes: Envelope[] = (
            await Promise.all(
                docs.map(async (d: Record<string, any>) =>
                    (await this._validator(d)) ? { payload: d, authorized_tokens: authorizedTokens } : null,
                ),
            )
        ).filter(Boolean) as Envelope[];

        const created = await this._repo.createMany(envelopes);
        res.send(created.map(({ id }): string => `${this._context}/${id}`));
    };

    bulk_read = async (req: Request, res: Response) => {
        const ids = (req.query.ids as string).split(',');
        const authToken = await this._authorizer.getAuthToken(req);

        const found = await this._repo.readMany(ids);
        const authorizedDocs = found.filter((r) => this._authorizer.isAuthorized(authToken, r));

        res.send(authorizedDocs.map((r) => r.payload));
    };
}
