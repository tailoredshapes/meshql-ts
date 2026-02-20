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

export const RestletteSchema = z.object({
    tokens: z.array(z.string()).optional(),
    path: z.string(),
    storage: StorageConfigSchema,
    schema: z.record(z.any()),
});

export type Restlette = z.infer<typeof RestletteSchema>;

export const ConfigSchema = z.object({
    casbinParams: z.array(z.string()).optional(),
    graphlettes: z.array(GraphletteSchema),
    port: z.number(),
    restlettes: z.array(RestletteSchema),
});

export type Config = z.infer<typeof ConfigSchema>;
