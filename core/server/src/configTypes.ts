import { RootConfigSchema } from '@tailoredshapes/meshql-common';
import { z } from 'zod';

export const StorageConfigSchema = z.object({
    type: z.string(),
});

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const GraphletteSchema = z.object({
    path: z.string(),
    storage: StorageConfigSchema,
    schema: z.string(),
    rootConfig: RootConfigSchema,
});

export type Graphlette = z.infer<typeof GraphletteSchema>;

/**
 * A restlette no longer carries a static `tokens` list. Deciding what mark a
 * new version is written with is `Session.stamp`, and the auth plugin owns it;
 * a config key that overrode the plugin's answer was an authorization decision
 * taken in the server's configuration file.
 */
export const RestletteSchema = z.object({
    path: z.string(),
    storage: StorageConfigSchema,
    schema: z.record(z.any()),
    /**
     * An event: a fact, created and never changed. `PUT` and `DELETE` on a
     * frozen restlette answer 405. A new state is a new document.
     */
    frozen: z.boolean().optional(),
    /**
     * A projection: written only by the worker(s) named here. A write
     * (`POST`, `PUT`, `DELETE`, bulk) from any caller whose bearer `sub` is not
     * one of these answers 403; reads are the auth plugin's, as for any
     * entity. The library knows nothing of how the worker is fed.
     */
    producedBy: z.union([z.string(), z.array(z.string())]).optional(),
});

export type Restlette = z.infer<typeof RestletteSchema>;

export const ConfigSchema = z.object({
    casbinParams: z.array(z.string()).optional(),
    graphlettes: z.array(GraphletteSchema),
    port: z.number(),
    restlettes: z.array(RestletteSchema),
});

export type Config = z.infer<typeof ConfigSchema>;
