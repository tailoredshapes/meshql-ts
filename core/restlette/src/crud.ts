import { SystemSession } from '@tailoredshapes/meshql-auth';
import Log4js from 'log4js';
import { Auth, Envelope, isUnauthorized, Repository, Session, Validator } from '@tailoredshapes/meshql-common';
import { Request, Response } from 'express';

const logger = Log4js.getLogger('meshql-ts/restlette');

export class Crud {
    private _authorizer: Auth;
    private _repo: Repository;
    private readonly _context: string;
    private readonly _validator: Validator;

    constructor(authorizer: Auth, repo: Repository, validator: Validator, context: string) {
        this._authorizer = authorizer;
        this._repo = repo;
        this._context = context;
        this._validator = validator;
    }

    /**
     * The envelope as storage holds it, fetched as the framework rather than
     * as the caller.
     *
     * A restlette answers 404 for a record that is not there and 403 for one
     * the caller may not have, and the two answers need different facts: that
     * it exists, and that the plugin refuses it. `read` under the caller's own
     * session collapses both into `undefined`.
     *
     * This is a fetch, not a decision. Every one of the three call sites below
     * asks the caller's session about the envelope it gets back, on the very
     * next line -- there is no path here that reads a record and skips the
     * question.
     */
    private async fetch(id: string): Promise<Envelope | undefined> {
        return this._repo.read(id, SystemSession);
    }

    create = async (req: Request, res: Response) => {
        const session: Session = await this._authorizer.authenticate(req);
        const payload: Record<string, any> = req.body;

        if (!(await this._validator(payload))) {
            res.status(400).send('Invalid document');
            return;
        }

        // The envelope carries no mark yet: `Repository.create` asks the
        // session to stamp one, because what a record is marked with is the
        // plugin's business and never the restlette's.
        const doc: Envelope = { payload };

        if (!(await session.isAuthorized('create', doc))) {
            res.status(403).send({});
            return;
        }

        const result: Envelope = await this._repo.create(doc, session);

        if (result) {
            logger.debug(`Created: ${JSON.stringify(result)}`);
            this.setHonestyHeaders(res, result);
            res.status(303).location(`${this._context}/${result.id}`).send();
        } else {
            logger.error(`Failed to create: ${JSON.stringify(doc)}`);
            res.status(400).send();
        }
    };

    /**
     * "Honesty" headers: the as-of timestamp and tombstone state, leaked
     * from the otherwise-internal Envelope so callers can tell how fresh
     * a payload is.
     */
    private setHonestyHeaders(res: Response, envelope: Envelope) {
        if (envelope.created_at) {
            res.setHeader('X-Meshql-Created-At', envelope.created_at.toISOString());
        }
        res.setHeader('X-Meshql-Deleted', String(Boolean(envelope.deleted)));
    }

    read = async (req: Request, res: Response) => {
        const id = req.params.id;
        const session: Session = await this._authorizer.authenticate(req);
        const result = await this.fetch(id);

        if (result) {
            res.setHeader('X-Canonical-Id', String(result.id));
            if (await session.isAuthorized('read', result)) {
                this.setHonestyHeaders(res, result);
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
        const session: Session = await this._authorizer.authenticate(req);
        const payload = req.body as any;

        if (!(await this._validator(payload))) {
            res.status(400).send('Invalid document');
            return;
        }

        const envelope: Envelope = { id, payload };
        const current = await this.fetch(id);

        if (!current) {
            res.status(404).send({});
            return;
        }

        // Replacing a record needs both halves of the question: may the caller
        // have the version that is there, and may they write the one going in.
        const permitted =
            (await session.isAuthorized('read', current)) && (await session.isAuthorized('create', envelope));

        if (!permitted) {
            res.status(403).send({});
            return;
        }

        const result = await this._repo.create(envelope, session);
        logger.debug(`Updated: ${JSON.stringify(result)}`);
        this.setHonestyHeaders(res, result);
        res.status(303).location(`${this._context}/${result.id}`).send();
    };

    remove = async (req: Request, res: Response) => {
        const id = req.params.id;
        const session: Session = await this._authorizer.authenticate(req);
        const current = await this.fetch(id);

        if (!current) {
            res.status(404).send({});
            return;
        }

        if (!(await session.isAuthorized('remove', current))) {
            res.status(403).send({});
            return;
        }

        const success = await this._repo.remove(id, session);
        if (success) {
            logger.debug(`Deleted: ${id}`);
            res.send({ deleted: id });
        } else {
            res.status(404).send({});
        }
    };

    /**
     * Every version of one document, oldest first.
     *
     * Each entry carries the URL that reaches it. A version the caller may not
     * read still appears, saying when it happened and whether it was a
     * deletion, and carrying no URL at all -- omitting the entry would make the
     * history look continuous when it is not.
     */
    list_versions = async (req: Request, res: Response) => {
        const id = req.params.id;
        const session: Session = await this._authorizer.authenticate(req);
        const versions = await this._repo.listVersions(id, session);

        res.send({
            id,
            versions: versions.map((version) =>
                version.token === undefined
                    ? {
                          created_at: version.created_at.toISOString(),
                          deleted: version.deleted,
                          unauthorized: true,
                      }
                    : {
                          url: `${this._context}/${id}/versions/${version.token}`,
                          created_at: version.created_at.toISOString(),
                          deleted: version.deleted,
                      },
            ),
        });
    };

    /**
     * One version, in the same shape as reading the document itself.
     *
     * An unknown token is a 404. A version the caller cannot read is a 403, not
     * a 404 -- the listing already told them it exists, and pretending
     * otherwise would contradict the answer they were just given.
     */
    read_version = async (req: Request, res: Response) => {
        const { id, token } = req.params;
        const session: Session = await this._authorizer.authenticate(req);

        try {
            const envelope = await this._repo.readVersion(id, token, session);
            if (!envelope) {
                res.status(404).send({});
                return;
            }
            this.setHonestyHeaders(res, envelope);
            res.send(envelope.payload);
        } catch (error) {
            if (isUnauthorized(error)) {
                res.status(403).send({});
                return;
            }
            logger.error(`Failed to read version ${token} of ${id}: ${error}`);
            res.status(500).send({});
        }
    };

    list = async (req: Request, res: Response) => {
        const session: Session = await this._authorizer.authenticate(req);
        // Storage filtered these by asking the session. The restlette does not
        // filter them again, because it has no rule of its own to apply.
        const results = await this._repo.list(session);
        res.send(results.map((r) => `${this._context}/${r.id}`));
    };

    bulk_create = async (req: Request, res: Response) => {
        const session: Session = await this._authorizer.authenticate(req);
        const docs: Record<string, any>[] = req.body as Record<string, any>[];

        const candidates: (Envelope | null)[] = await Promise.all(
            docs.map(async (d: Record<string, any>) => {
                if (!(await this._validator(d))) return null;
                const envelope: Envelope = { payload: d };
                return (await session.isAuthorized('create', envelope)) ? envelope : null;
            }),
        );

        const envelopes: Envelope[] = candidates.filter(Boolean) as Envelope[];

        const created = await this._repo.createMany(envelopes, session);
        res.send(created.map(({ id }): string => `${this._context}/${id}`));
    };

    bulk_read = async (req: Request, res: Response) => {
        const session: Session = await this._authorizer.authenticate(req);
        const ids = (req.query.ids as string).split(',');

        const found = await this._repo.readMany(ids, session);

        res.send(found.map((r) => r.payload));
    };
}
