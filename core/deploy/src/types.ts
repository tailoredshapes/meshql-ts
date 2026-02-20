// Re-export types from existing packages
export type {
    Config,
    Graphlette,
    Restlette,
    StorageConfig
} from '@tailoredshapes/meshql-server';

export type {
    Singleton,
    Vector,
    Resolver,
    RootConfig
} from '@tailoredshapes/meshql-common';

// Deployment-specific storage config
// This represents the full storage configuration needed for generating HOCON files
// At runtime, this gets parsed and passed to the appropriate database plugin
export interface DeploymentStorageConfig {
    type: string;
    uri?: string;
    db?: string;
    collection: string;
    options?: Record<string, any>;
}

// Docker-specific types (these don't exist elsewhere)
export interface DockerServiceConfig {
    image?: string;
    build?: {
        context: string;
        dockerfile: string;
    };
    ports?: string[];
    environment?: string[];
    volumes?: string[];
    depends_on?: Record<string, { condition: string }>;
    healthcheck?: {
        test: string[];
        interval: string;
        timeout: string;
        retries: number;
        start_period: string;
    };
}

export interface DockerComposeConfig {
    services: Record<string, DockerServiceConfig>;
}
