import { Repository, Searcher } from '@tailoredshapes/meshql-common';
import { StorageConfig } from './configTypes';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';

/**
 * A storage plugin. Note what it is not handed: an `Auth`.
 *
 * A searcher gets the caller's session per call, along with the query, and
 * asks it about each envelope it found. It never holds credentials and never
 * holds the plugin that resolves them.
 */
export interface Plugin {
    createRepository: (config: StorageConfig) => Promise<Repository>;
    createSearcher: (config: StorageConfig, dtoFactory: DTOFactory) => Promise<Searcher>;
    cleanup: () => Promise<void>;
}
