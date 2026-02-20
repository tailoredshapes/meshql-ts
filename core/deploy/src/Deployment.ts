/* eslint-disable no-console */
import { Service } from './Service.js';
import { Database } from './Database.js';
import { DockerComposeConfig, Config, DeploymentStorageConfig } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface DeploymentOptions {
    outputDir?: string;
    dockerContext?: string;
    dockerfile?: string;
    mongoImage?: string;
    deploymentDir?: string;  // Directory where the deployment script is located
}

export class Deployment {
    private services: Map<string, Service> = new Map();
    private databases: Database[] = [];
    private options: DeploymentOptions;

    constructor(services: Service[], options: DeploymentOptions = {}) {
        services.forEach(s => this.services.set(s.name, s));

        this.options = {
            outputDir: options.outputDir || './generated',
            dockerContext: options.dockerContext || '../..',
            dockerfile: options.dockerfile || 'examples/farm/Dockerfile',
            mongoImage: options.mongoImage || 'mongo:latest'
        };
    }

    withDatabase(db: Database): this {
        this.databases.push(db);
        return this;
    }

    getService(name: string): Service | undefined {
        return this.services.get(name);
    }

    /**
     * Validate deployment configuration
     */
    validate(): string[] {
        const errors: string[] = [];

        // Check for port conflicts
        const ports = new Map<number, string[]>();
        this.services.forEach(service => {
            const existing = ports.get(service.port) || [];
            existing.push(service.name);
            ports.set(service.port, existing);
        });

        ports.forEach((serviceNames, port) => {
            if (serviceNames.length > 1) {
                errors.push(`Port conflict: Services ${serviceNames.join(', ')} all use port ${port}`);
            }
        });

        // Validate resolver references
        this.services.forEach(service => {
            const config = service.generateConfig();
            config.graphlettes.forEach(graphlette => {
                graphlette.rootConfig.resolvers?.forEach(resolver => {
                    const match = resolver.url.match(/http:\/\/([^:]+):/);
                    if (match) {
                        const targetServiceName = match[1];
                        if (!this.services.has(targetServiceName)) {
                            errors.push(
                                `Service '${service.name}' resolver '${resolver.name}' references unknown service '${targetServiceName}'`
                            );
                        }
                    }
                });
            });
        });

        return errors;
    }

    /**
     * Generate docker-compose.yml
     */
    generateDockerCompose(): DockerComposeConfig {
        const compose: DockerComposeConfig = {
            services: {}
        };

        // Add MongoDB if needed
        if (this.databases.some(db => db.type === 'mongo')) {
            compose.services.mongodb = {
                image: this.options.mongoImage,
                ports: ['27017:27017'],
                environment: ['MONGO_INITDB_DATABASE=app_db'],
                healthcheck: {
                    test: ['CMD', 'mongosh', '--eval', "db.adminCommand('ping')"],
                    interval: '5s',
                    timeout: '5s',
                    retries: 5,
                    start_period: '10s'
                }
            };
        }

        // Calculate dockerContext relative to outputDir (where docker-compose.yml will be)
        const outputDirAbs = path.resolve(this.options.outputDir!);
        const dockerContextAbs = path.resolve(this.options.dockerContext!);
        const dockerContextRelative = path.relative(outputDirAbs, dockerContextAbs).replace(/\\/g, '/');

        // Add application services
        this.services.forEach(service => {
            const envVars = service.getEnvVars();

            // Calculate dockerfile path relative to docker context
            const dockerfilePath = path.relative(
                dockerContextAbs,
                path.join(outputDirAbs, service.name, 'Dockerfile')
            ).replace(/\\/g, '/');

            compose.services[service.name] = {
                build: {
                    context: dockerContextRelative,
                    dockerfile: dockerfilePath
                },
                ports: [`${service.port}:${service.port}`],
                environment: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
                depends_on: {
                    mongodb: { condition: 'service_healthy' }
                },
                healthcheck: {
                    test: ['CMD', 'curl', '-f', `http://localhost:${service.port}/ready`],
                    interval: '10s',
                    timeout: '5s',
                    retries: 5,
                    start_period: '30s'
                }
            };

            // Add cross-service ports
            this.services.forEach(otherService => {
                if (otherService.name !== service.name) {
                    const envKey = `${otherService.name.toUpperCase()}_PORT`;
                    compose.services[service.name].environment!.push(`${envKey}=${otherService.port}`);
                }
            });

            // Add database URI
            if (this.databases.some(db => db.type === 'mongo')) {
                compose.services[service.name].environment!.push('MONGO_URI=mongodb://mongodb:27017/app_db');
            }
        });

        return compose;
    }

    /**
     * Generate TypeScript server entrypoint from a Config object
     */
    generateServiceEntrypoint(serviceName: string): string {
        const service = this.services.get(serviceName);
        if (!service) {
            throw new Error(`Service '${serviceName}' not found`);
        }

        const config = service.generateConfig();
        const envVars = service.getEnvVars();

        // Determine which database plugins are needed
        const dbTypes = new Set<string>();
        [...config.graphlettes, ...config.restlettes].forEach(endpoint => {
            const storage = endpoint.storage as DeploymentStorageConfig;
            dbTypes.add(storage.type);
        });

        return this.configToTypeScript(config, envVars, dbTypes);
    }

    /**
     * Convert a Config object to TypeScript server entrypoint
     */
    private configToTypeScript(config: Config, envVars: Record<string, string>, dbTypes: Set<string>): string {
        let ts = '// Auto-generated by @tailoredshapes/meshql-deploy\n\n';

        // Imports
        ts += `import { init } from '@tailoredshapes/meshql-server';\n`;
        ts += `import { configureLogging, getLogger } from '@tailoredshapes/meshql-common';\n`;

        // Import database plugins
        const pluginMap: Record<string, {pkg: string, class: string}> = {
            'mongo': {pkg: '@tailoredshapes/meshql-mongo_repo', class: 'MongoPlugin'},
            'postgres': {pkg: '@tailoredshapes/meshql-postgres_repo', class: 'PostgresPlugin'},
            'mysql': {pkg: '@tailoredshapes/meshql-mysql_repo', class: 'MySQLPlugin'},
            'sqlite': {pkg: '@tailoredshapes/meshql-sqlite_repo', class: 'SQLitePlugin'}
        };

        dbTypes.forEach(type => {
            if (pluginMap[type]) {
                ts += `import { ${pluginMap[type].class} } from '${pluginMap[type].pkg}';\n`;
            }
        });

        ts += `\n`;
        ts += `configureLogging('debug');\n`;
        ts += `const log = getLogger('meshql-ts/server');\n\n`;

        // Config object (no type annotation to allow extended storage properties)
        ts += `const config = {\n`;
        ts += `  port: parseInt(process.env.PORT || '${config.port}'),\n`;
        ts += `  graphlettes: [\n`;

        config.graphlettes.forEach(g => {
            const storage = g.storage as DeploymentStorageConfig;
            ts += `    {\n`;
            ts += `      path: '${g.path}',\n`;
            ts += `      storage: {\n`;
            ts += `        type: '${storage.type}',\n`;
            if (storage.uri) ts += `        uri: process.env.MONGO_URI || '${storage.uri}',\n`;
            if (storage.db) ts += `        db: \`\${process.env.PREFIX || '${envVars.PREFIX}'}_\${process.env.ENV || '${envVars.ENV}'}\`,\n`;
            ts += `        collection: '${storage.collection}',\n`;
            if (storage.options) {
                ts += `        options: ${JSON.stringify(storage.options)}\n`;
            }
            ts += `      },\n`;
            ts += `      schema: \`${g.schema.replace(/`/g, '\\`')}\`,\n`;
            ts += `      rootConfig: {\n`;

            if (g.rootConfig.singletons && g.rootConfig.singletons.length > 0) {
                ts += `        singletons: [\n`;
                g.rootConfig.singletons.forEach(s => {
                    ts += `          { name: '${s.name}', query: '${s.query.replace(/'/g, "\\'")}'`;
                    if (s.id) ts += `, id: '${s.id}'`;
                    ts += ` },\n`;
                });
                ts += `        ],\n`;
            }

            if (g.rootConfig.vectors && g.rootConfig.vectors.length > 0) {
                ts += `        vectors: [\n`;
                g.rootConfig.vectors.forEach(v => {
                    ts += `          { name: '${v.name}', query: '${v.query.replace(/'/g, "\\'")}'`;
                    if (v.id) ts += `, id: '${v.id}'`;
                    ts += ` },\n`;
                });
                ts += `        ],\n`;
            }

            if (g.rootConfig.resolvers && g.rootConfig.resolvers.length > 0) {
                ts += `        resolvers: [\n`;
                g.rootConfig.resolvers.forEach(r => {
                    ts += `          { name: '${r.name}', queryName: '${r.queryName}', url: '${r.url}'`;
                    if (r.id) ts += `, id: '${r.id}'`;
                    ts += ` },\n`;
                });
                ts += `        ]\n`;
            }

            ts += `      }\n`;
            ts += `    },\n`;
        });

        ts += `  ],\n`;
        ts += `  restlettes: [\n`;

        config.restlettes.forEach(r => {
            const storage = r.storage as DeploymentStorageConfig;
            ts += `    {\n`;
            ts += `      path: '${r.path}',\n`;
            ts += `      storage: {\n`;
            ts += `        type: '${storage.type}',\n`;
            if (storage.uri) ts += `        uri: process.env.MONGO_URI || '${storage.uri}',\n`;
            if (storage.db) ts += `        db: \`\${process.env.PREFIX || '${envVars.PREFIX}'}_\${process.env.ENV || '${envVars.ENV}'}\`,\n`;
            ts += `        collection: '${storage.collection}',\n`;
            if (storage.options) {
                ts += `        options: ${JSON.stringify(storage.options)}\n`;
            }
            ts += `      },\n`;
            ts += `      schema: ${JSON.stringify(r.schema, null, 2).split('\n').join('\n      ')}\n`;
            ts += `    },\n`;
        });

        ts += `  ]\n`;
        ts += `};\n\n`;

        // Plugins
        ts += `const plugins = {\n`;
        dbTypes.forEach(type => {
            if (pluginMap[type]) {
                ts += `  ${type}: new ${pluginMap[type].class}(),\n`;
            }
        });
        ts += `};\n\n`;

        // Start server
        ts += `init(config, plugins)\n`;
        ts += `  .then(app => {\n`;
        ts += `    app.listen(config.port, () => {\n`;
        ts += `      log.info(\`Server running on port \${config.port}\`);\n`;
        ts += `    });\n`;
        ts += `  })\n`;
        ts += `  .catch(err => {\n`;
        ts += `    log.error('Failed to start server:', err);\n`;
        ts += `    process.exit(1);\n`;
        ts += `  });\n`;

        return ts;
    }

    /**
     * Generate a Dockerfile for a service
     */
    private generateDockerfile(serviceName: string): string {
        // Calculate path from docker context to server.ts
        // outputDir is typically an absolute path like /tank/repos/meshql-ts/examples/twofarms/generated
        // dockerContext is typically a relative path like '../../..' from deployment dir
        //
        // We need to find the path from dockerContext root to server.ts

        const outputDirAbs = path.resolve(this.options.outputDir!);
        const dockerContextAbs = path.resolve(this.options.dockerContext!);

        // Path from docker context to server.ts
        const relativeServerPath = path.relative(
            dockerContextAbs,
            path.join(outputDirAbs, serviceName, 'server.ts')
        ).replace(/\\/g, '/');

        let dockerfile = `FROM node:20-slim\n`;
        dockerfile += `ENV YARN_VERSION=4.6.0\n\n`;
        dockerfile += `# Disable colors for cleaner logs\n`;
        dockerfile += `ENV FORCE_COLOR=0\n`;
        dockerfile += `ENV YARN_ENABLE_PROGRESS_BARS=false\n`;
        dockerfile += `ENV YARN_ENABLE_COLORS=false\n\n`;
        dockerfile += `RUN corepack enable && corepack prepare yarn@\${YARN_VERSION}\n\n`;
        dockerfile += `WORKDIR /app\n\n`;
        dockerfile += `# Copy package files first for better caching\n`;
        dockerfile += `COPY package.json yarn.lock lerna.json tsconfig.json tsconfig.base.json ./\n`;
        dockerfile += `COPY .yarnrc.yml ./\n`;
        dockerfile += `COPY .yarn ./.yarn\n\n`;
        dockerfile += `# Copy the rest of the application\n`;
        dockerfile += `COPY core ./core\n`;
        dockerfile += `COPY repos ./repos\n\n`;
        dockerfile += `# Install dependencies\n`;
        dockerfile += `RUN yarn install\n\n`;
        dockerfile += `# Build all packages\n`;
        dockerfile += `RUN yarn build\n\n`;
        dockerfile += `# Set production mode\n`;
        dockerfile += `ENV NODE_ENV=production\n\n`;
        dockerfile += `# Copy the service entrypoint\n`;
        dockerfile += `COPY ${relativeServerPath} /app/server.ts\n\n`;
        dockerfile += `# Start the service using tsx (TypeScript runner)\n`;
        dockerfile += `CMD ["npx", "tsx", "/app/server.ts"]\n`;

        return dockerfile;
    }

    /**
     * DEPRECATED: Convert a Config object to HOCON format (to be removed)
     */
    private configToHOCON_DEPRECATED(config: Config): string {
        let hocon = '{\n';
        hocon += `  port = \${?PORT}\n`;
        hocon += `  url = \${?PLATFORM_URL}\n\n`;

        // Collect unique databases
        const dbConfigs = new Map<string, DeploymentStorageConfig>();
        [...config.graphlettes, ...config.restlettes].forEach(endpoint => {
            const storage = endpoint.storage as DeploymentStorageConfig;
            const dbName = `${storage.collection}DB`;
            if (!dbConfigs.has(dbName)) {
                dbConfigs.set(dbName, storage);
            }
        });

        // Write database configs
        dbConfigs.forEach((storage, dbName) => {
            hocon += `  ${dbName} = {\n`;
            hocon += `    type = "${storage.type}"\n`;
            hocon += `    uri = \${?MONGO_URI}\n`;
            hocon += `    db = \${?PREFIX}_\${?ENV}\n`;
            hocon += `    collection = "${storage.collection}"\n`;
            if (storage.options) {
                hocon += `    options {\n`;
                Object.entries(storage.options).forEach(([k, v]) => {
                    hocon += `      ${k} = ${JSON.stringify(v)}\n`;
                });
                hocon += `    }\n`;
            }
            hocon += `  }\n\n`;
        });

        // Write graphlettes
        if (config.graphlettes.length > 0) {
            hocon += `  graphlettes = [\n`;
            config.graphlettes.forEach(g => {
                const storage = g.storage as DeploymentStorageConfig;
                hocon += `    {\n`;
                hocon += `      path = "${g.path}"\n`;
                hocon += `      storage = \${${storage.collection}DB}\n`;
                hocon += `      schema = include file(./graph${g.path}.graphql)\n`;
                hocon += `      rootConfig {\n`;

                if (g.rootConfig.singletons && g.rootConfig.singletons.length > 0) {
                    hocon += `        singletons = [\n`;
                    g.rootConfig.singletons.forEach(s => {
                        hocon += `          { name = "${s.name}", query = """${s.query}"""`;
                        if (s.id) hocon += `, id = "${s.id}"`;
                        hocon += ` }\n`;
                    });
                    hocon += `        ]\n`;
                }

                if (g.rootConfig.vectors && g.rootConfig.vectors.length > 0) {
                    hocon += `        vectors = [\n`;
                    g.rootConfig.vectors.forEach(v => {
                        hocon += `          { name = "${v.name}", query = """${v.query}"""`;
                        if (v.id) hocon += `, id = "${v.id}"`;
                        hocon += ` }\n`;
                    });
                    hocon += `        ]\n`;
                }

                if (g.rootConfig.resolvers && g.rootConfig.resolvers.length > 0) {
                    hocon += `        resolvers = [\n`;
                    g.rootConfig.resolvers.forEach(r => {
                        hocon += `          { name = "${r.name}", queryName = "${r.queryName}", url = "${r.url}"`;
                        if (r.id) hocon += `, id = "${r.id}"`;
                        hocon += ` }\n`;
                    });
                    hocon += `        ]\n`;
                }

                hocon += `      }\n`;
                hocon += `    }\n`;
            });
            hocon += `  ]\n\n`;
        }

        // Write restlettes
        if (config.restlettes.length > 0) {
            hocon += `  restlettes = [\n`;
            config.restlettes.forEach(r => {
                const storage = r.storage as DeploymentStorageConfig;
                hocon += `    {\n`;
                hocon += `      path = "${r.path}"\n`;
                hocon += `      storage = \${${storage.collection}DB}\n`;
                hocon += `      schema = include file(./json${r.path}.schema.json)\n`;
                hocon += `    }\n`;
            });
            hocon += `  ]\n`;
        }

        hocon += '}\n';
        return hocon;
    }

    /**
     * Generate all files
     */
    async generate(): Promise<void> {
        const errors = this.validate();
        if (errors.length > 0) {
            throw new Error(`Validation failed:\n${errors.join('\n')}`);
        }

        const outputDir = this.options.outputDir!;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Generate docker-compose.yml
        const dockerCompose = this.generateDockerCompose();
        fs.writeFileSync(path.join(outputDir, 'docker-compose.yml'), yaml.dump(dockerCompose));
        console.log(`✓ Generated ${outputDir}/docker-compose.yml`);

        // Generate TypeScript server entrypoint and Dockerfile for each service
        this.services.forEach(service => {
            const serviceDir = path.join(outputDir, service.name);
            if (!fs.existsSync(serviceDir)) {
                fs.mkdirSync(serviceDir, { recursive: true });
            }

            const entrypoint = this.generateServiceEntrypoint(service.name);
            fs.writeFileSync(path.join(serviceDir, 'server.ts'), entrypoint);
            console.log(`✓ Generated ${serviceDir}/server.ts`);

            const dockerfile = this.generateDockerfile(service.name);
            fs.writeFileSync(path.join(serviceDir, 'Dockerfile'), dockerfile);
            console.log(`✓ Generated ${serviceDir}/Dockerfile`);
        });

        // Generate endpoints.ts
        const testEndpoints = this.generateTestEndpoints();
        fs.writeFileSync(path.join(outputDir, 'endpoints.ts'), testEndpoints);
        console.log(`✓ Generated ${outputDir}/endpoints.ts`);

        console.log('\n✓ Deployment configuration generated successfully!');
        console.log(`  Run: cd ${outputDir} && docker-compose up`);
    }

    private generateTestEndpoints(): string {
        let ts = '// Auto-generated by @tailoredshapes/meshql-deploy\n\n';
        ts += 'export const endpoints = {\n';

        this.services.forEach(service => {
            ts += `  ${service.name}: {\n`;
            ts += `    port: ${service.port},\n`;
            ts += `    url: 'http://localhost:${service.port}',\n`;
            ts += `    endpoints: {\n`;

            service.getEndpoints().forEach(endpoint => {
                const safeName = endpoint.path.replace(/\//g, '_').replace(/^_/, '');
                ts += `      ${safeName}: {\n`;
                ts += `        type: '${endpoint.type}',\n`;
                ts += `        path: '${endpoint.path}',\n`;
                ts += `        url: 'http://localhost:${service.port}${endpoint.path}'\n`;
                ts += `      },\n`;
            });

            ts += `    }\n`;
            ts += `  },\n`;
        });

        ts += '} as const;\n';
        return ts;
    }
}
