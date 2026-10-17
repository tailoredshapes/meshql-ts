import { Config as MeshQLConfig, StorageConfig } from '@tailoredshapes/meshql-server';

/**
 * ---------------------------------------------------------------------------
 * The egg economy deployment
 * ---------------------------------------------------------------------------
 *
 * `features/contract/features/proposed/egg-economy/egg_economy.feature` and
 * `specs/egg-economy.md` (in the contract) describe fourteen entities in three
 * kinds, written by three different parties:
 *
 *   actor       written directly through its restlette by the front end
 *   event       a fact: the front end creates it, and nothing changes it
 *               (`frozen`: PUT and DELETE answer 405)
 *   projection  written only by its worker (`producedBy`: every write that
 *               does not carry the worker's credentials answers 403)
 *
 * This file is that table, and the one place the deployment is derived from
 * it: for each entity a JSON Schema for its restlette, a GraphQL schema for
 * its graphlette, and the singletons, vectors and resolvers that federate it
 * to the entities it refers to and to those that refer to it.
 *
 * Nothing here knows how an event reaches a worker. That is the mesh around
 * the meshlettes; the harness (egg.ts) supplies one so the surfaces have data.
 */

export type EggKind = 'actor' | 'event' | 'projection';
type Scalar = 'string' | 'int' | 'number' | 'boolean';

type Field = {
    type: Scalar;
    required?: boolean;
    /** The entity this field holds the id of. */
    ref?: string;
    /** The referrer is at most one: the target reads it as this singleton field, not a list. */
    one?: string;
    /** The name the target gives its (list of) referrers, where `<entity>s` is not a word. */
    as?: string;
};

export type EggEntity = {
    name: string;
    kind: EggKind;
    fields: Record<string, Field>;
    /** The workers whose credentials may write this projection. */
    producedBy?: string[];
};

const str = (required = false): Field => ({ type: 'string', required });
const int = (required = false): Field => ({ type: 'int', required });
const num = (required = false): Field => ({ type: 'number', required });
const ref = (to: string, one?: string, as?: string): Field => ({ type: 'string', required: true, ref: to, one, as });

export const EGG_ECONOMY: EggEntity[] = [
    // actors
    { name: 'farm', kind: 'actor', fields: { name: str(true), farm_type: str(true), zone: str(true), owner: str() } },
    {
        name: 'coop',
        kind: 'actor',
        fields: { name: str(true), farm_id: ref('farm'), capacity: int(true), coop_type: str(true) },
    },
    {
        name: 'hen',
        kind: 'actor',
        fields: { name: str(true), coop_id: ref('coop'), breed: str(true), dob: str(), status: str() },
    },
    {
        name: 'container',
        kind: 'actor',
        fields: { name: str(true), container_type: str(true), capacity: int(true), zone: str(true) },
    },
    {
        name: 'consumer',
        kind: 'actor',
        fields: { name: str(true), consumer_type: str(true), zone: str(true), weekly_demand: int() },
    },
    // events
    {
        name: 'lay_report',
        kind: 'event',
        fields: {
            hen_id: ref('hen'),
            coop_id: ref('coop'),
            farm_id: ref('farm'),
            eggs: int(true),
            quality: str(),
            timestamp: str(true),
        },
    },
    {
        name: 'storage_deposit',
        kind: 'event',
        fields: {
            container_id: ref('container'),
            source_type: str(true),
            source_id: str(true),
            eggs: int(true),
            timestamp: str(true),
        },
    },
    {
        name: 'storage_withdrawal',
        kind: 'event',
        fields: { container_id: ref('container'), reason: str(true), eggs: int(true), timestamp: str(true) },
    },
    {
        name: 'container_transfer',
        kind: 'event',
        fields: {
            source_container_id: ref('container'),
            dest_container_id: ref('container'),
            eggs: int(true),
            transport_method: str(),
            timestamp: str(true),
        },
    },
    {
        name: 'consumption_report',
        kind: 'event',
        fields: {
            consumer_id: ref('consumer'),
            container_id: ref('container'),
            purpose: str(),
            eggs: int(true),
            timestamp: str(true),
        },
    },
    // projections
    {
        name: 'hen_productivity',
        kind: 'projection',
        producedBy: ['hen_worker'],
        fields: {
            hen_id: ref('hen', 'productivity'),
            farm_id: ref('farm', undefined, 'hen_productivities'),
            total_eggs: int(true),
            quality_rate: num(true),
        },
    },
    {
        name: 'farm_output',
        kind: 'projection',
        producedBy: ['farm_worker'],
        fields: { farm_id: ref('farm', 'output'), total_eggs: int(true), total_hens: int(true) },
    },
    {
        name: 'container_inventory',
        kind: 'projection',
        producedBy: ['container_worker'],
        fields: {
            container_id: ref('container', 'inventory'),
            current_eggs: int(true),
            total_deposits: int(true),
            total_withdrawals: int(true),
            total_transfers_in: int(true),
            total_transfers_out: int(true),
            total_consumed: int(true),
            utilization_pct: num(),
        },
    },
    {
        // An event the domain refused. `aggregate_id` names a hen or a container,
        // so it is not a reference.
        name: 'rejection',
        kind: 'projection',
        producedBy: ['hen_worker', 'container_worker'],
        fields: {
            event_entity: str(true),
            event_id: str(true),
            aggregate_id: str(true),
            actor: str(),
            timestamp: str(),
            reason: str(true),
            withdrawn: { type: 'boolean' },
        },
    },
];

/**
 * How a store spells "the payload's `field` equals the argument". The query
 * templates are the deployment's (and so each adapter's hooks supply them);
 * the shape of the mesh is not.
 */
export interface EggDialect {
    /** `id = '{{id}}'` */
    byId: string;
    /** For example `payload->>'hen_id' = '{{id}}'`: the argument is named `arg`. */
    where(field: string, arg: string): string;
}

const pascal = (s: string): string => s.replace(/(^|_)(\w)/g, (_m, _u, c) => c.toUpperCase());
const stem = (field: string): string => field.replace(/_id$/, '');
const GRAPH_TYPE: Record<Scalar, string> = { string: 'String', int: 'Int', number: 'Float', boolean: 'Boolean' };

type Referrer = { by: EggEntity; field: string; name: string; one: boolean };

/** Every entity's referrers of `target`, named for the entity (lay_reports) or, when it refers twice, the field too. */
function referrers(target: string): Referrer[] {
    const out: Referrer[] = [];
    for (const by of EGG_ECONOMY) {
        const fields = Object.entries(by.fields).filter(([, f]) => f.ref === target);
        for (const [field, f] of fields) {
            const name = f.one ?? f.as ?? (fields.length === 1 ? `${by.name}s` : `${by.name}s_by_${stem(field)}`);
            out.push({ by, field, name, one: f.one !== undefined });
        }
    }
    return out;
}

export function jsonSchemaOf(entity: EggEntity): Record<string, any> {
    const properties: Record<string, any> = { id: { type: 'string' } };
    for (const [name, f] of Object.entries(entity.fields)) {
        properties[name] = { type: f.type === 'int' ? 'integer' : f.type };
    }
    const required = Object.entries(entity.fields)
        .filter(([, f]) => f.required)
        .map(([name]) => name);
    return { type: 'object', additionalProperties: false, required, properties };
}

/**
 * One GraphQL schema shared by the fourteen graphlettes, each with its own
 * `Query`. A graphlette validates the whole selection it is asked for, even
 * the parts it hands to a sibling, so every graphlette must be able to
 * describe every type; they differ only in which entity they serve.
 */
function typesSdl(): string {
    return EGG_ECONOMY.map((e) => {
        const lines = ['  id: ID', '  createdAt: String'];
        for (const [name, f] of Object.entries(e.fields)) {
            lines.push(`  ${name}: ${GRAPH_TYPE[f.type]}`);
            if (f.ref) lines.push(`  ${stem(name)}: ${pascal(f.ref)}`);
        }
        for (const r of referrers(e.name)) {
            lines.push(`  ${r.name}: ${r.one ? pascal(r.by.name) : `[${pascal(r.by.name)}]`}`);
        }
        return `type ${pascal(e.name)} {\n${lines.join('\n')}\n}`;
    }).join('\n\n');
}

export function graphSchemaOf(entity: EggEntity): string {
    const T = pascal(entity.name);
    const queries = [`  getById(id: ID, at: Float): ${T}`];
    if (entity.fields.name) queries.push(`  getByName(name: String, at: Float): ${T}`);
    for (const [field, f] of Object.entries(entity.fields)) {
        if (f.ref) queries.push(`  getBy${pascal(stem(field))}(id: ID, at: Float): ${f.one ? T : `[${T}]`}`);
    }
    return `scalar Date\n\ntype Query {\n${queries.join('\n')}\n}\n\n${typesSdl()}\n`;
}

/**
 * The whole deployment: a restlette at /<entity>/api and a graphlette at
 * /<entity>/graph for each entity.
 *
 * @param base the origin the graphlettes reach one another at
 */
export function eggConfig(
    port: number,
    base: string,
    storageFor: (entity: string) => StorageConfig,
    dialect: EggDialect,
): MeshQLConfig {
    return {
        port,
        graphlettes: EGG_ECONOMY.map((e) => {
            const singletons: any[] = [{ name: 'getById', query: dialect.byId }];
            if (e.fields.name) {
                singletons.push({ name: 'getByName', query: dialect.where('name', 'name') });
            }
            const vectors: any[] = [];
            const resolvers: any[] = [];
            for (const [field, f] of Object.entries(e.fields)) {
                if (!f.ref) continue;
                const queryName = `getBy${pascal(stem(field))}`;
                (f.one ? singletons : vectors).push({ name: queryName, query: dialect.where(field, 'id') });
                // forward: the thing this one refers to
                resolvers.push({ name: stem(field), id: field, queryName: 'getById', url: `${base}/${f.ref}/graph` });
            }
            // backward: the things that refer to this one
            for (const r of referrers(e.name)) {
                resolvers.push({
                    name: r.name,
                    queryName: `getBy${pascal(stem(r.field))}`,
                    url: `${base}/${r.by.name}/graph`,
                });
            }
            return {
                path: `/${e.name}/graph`,
                storage: storageFor(e.name),
                schema: graphSchemaOf(e),
                rootConfig: { singletons, vectors, resolvers },
            };
        }),
        restlettes: EGG_ECONOMY.map((e) => ({
            path: `/${e.name}/api`,
            storage: storageFor(e.name),
            schema: jsonSchemaOf(e),
            ...(e.kind === 'event' ? { frozen: true } : {}),
            ...(e.kind === 'projection' ? { producedBy: e.producedBy } : {}),
        })),
    };
}
