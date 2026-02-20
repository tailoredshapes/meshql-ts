import { Repository, Searcher } from '@tailoredshapes/meshql-common';
import { StorageConfig } from './configTypes';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { Auth } from '@tailoredshapes/meshql-auth';

export interface Plugin {
    createRepository: (config: StorageConfig) => Promise<Repository>;
    createSearcher: (config: StorageConfig, dtoFactory: DTOFactory, auth: Auth) => Promise<Searcher>;
    cleanup: () => Promise<void>;
}
