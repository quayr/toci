import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Credential payload returned by credential stores and login helpers.
 */
export type Credential = {
  /** Username returned by basic auth helpers. */
  username?: string;
  /** Password returned by basic auth helpers. */
  password?: string;
  /** Refresh token returned by token-based helpers. */
  refreshToken?: string;
  /** Access token returned by registry token helpers. */
  accessToken?: string;
};

/**
 * Resolves credentials for a registry host and port.
 */
export type CredentialFunc = (ctx: unknown, hostport: string) => Promise<Credential> | Credential;

/**
 * Pluggable credential store contract.
 */
export interface CredentialStore {
  /**
   * Retrieves credentials for a server address.
   *
   * @param ctx - Request-scoped context.
   * @param serverAddress - Docker-style server address key.
   * @returns The resolved credentials, or an empty credential when none exists.
   */
  Get(ctx: unknown, serverAddress: string): Promise<Credential> | Credential;
  /**
   * Persists credentials for a server address.
   *
   * @param ctx - Request-scoped context.
   * @param serverAddress - Docker-style server address key.
   * @param cred - Credential payload to store.
   */
  Put?(ctx: unknown, serverAddress: string, cred: Credential): Promise<void> | void;
  /**
   * Deletes credentials for a server address.
   *
   * @param ctx - Request-scoped context.
   * @param serverAddress - Docker-style server address key.
   */
  Delete?(ctx: unknown, serverAddress: string): Promise<void> | void;
}

/**
 * Options for Docker config-backed credential stores.
 */
export interface DockerConfigCredentialStoreOptions {
  /** Enables plaintext writes when no native helper is available. */
  allowPlaintextPut?: boolean;
  /** Detects the platform default native helper when the config has no auth settings. */
  detectDefaultNativeStore?: boolean;
  /** Factory used to create helper-backed credential stores. */
  nativeStoreFactory?: (helperSuffix: string) => CredentialStore;
}

/**
 * Credential store that falls back to additional stores until one returns a value.
 */
export class FallbackCredentialStore implements CredentialStore {
  constructor(
    private readonly primary: CredentialStore,
    private readonly fallbacks: CredentialStore[] = [],
  ) { }

  /** @inheritdoc */
  async Get(ctx: unknown, serverAddress: string): Promise<Credential> {
    const stores = [this.primary, ...this.fallbacks];
    for (const store of stores) {
      const cred = await store.Get(ctx, serverAddress);
      if (!isEmptyCredential(cred)) {
        return cred;
      }
    }
    return {};
  }

  /** @inheritdoc */
  async Put(ctx: unknown, serverAddress: string, cred: Credential): Promise<void> {
    if (!this.primary.Put) {
      throw new Error('primary credential store does not support put');
    }
    await this.primary.Put(ctx, serverAddress, cred);
  }

  /** @inheritdoc */
  async Delete(ctx: unknown, serverAddress: string): Promise<void> {
    if (!this.primary.Delete) {
      throw new Error('primary credential store does not support delete');
    }
    await this.primary.Delete(ctx, serverAddress);
  }
}

export interface CredentialStoreExecutor {
  Execute(ctx: unknown, input: string, action: 'get' | 'store' | 'erase'): Promise<{ stdout: string }> | { stdout: string };
}

type DockerAuthConfig = {
  auth?: string;
  identitytoken?: string;
  registrytoken?: string;
  username?: string;
  password?: string;
};

type DockerConfig = {
  auths?: Record<string, DockerAuthConfig>;
};

/**
 * In-memory credential store for tests and ephemeral use.
 */
export class CredentialMemoryStore implements CredentialStore {
  private readonly store = new Map<string, Credential>();

  constructor(initial?: Record<string, Credential>) {
    if (!initial) {
      return;
    }

    for (const [serverAddress, cred] of Object.entries(initial)) {
      this.store.set(serverAddress, { ...cred });
    }
  }

  /** @inheritdoc */
  Get(_ctx: unknown, serverAddress: string): Credential {
    return this.store.get(serverAddress) ?? {};
  }

  /** @inheritdoc */
  Put(_ctx: unknown, serverAddress: string, cred: Credential): void {
    this.store.set(serverAddress, { ...cred });
  }

  /** @inheritdoc */
  Delete(_ctx: unknown, serverAddress: string): void {
    this.store.delete(serverAddress);
  }
}

type DockerConfigAuthConfig = {
  auth?: string;
  identitytoken?: string;
  registrytoken?: string;
  username?: string;
  password?: string;
};

type DockerConfigFile = {
  auths?: Record<string, DockerConfigAuthConfig>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
  [key: string]: unknown;
};

type HelperCredentialStore = {
  Get(ctx: unknown, serverAddress: string): Promise<Credential> | Credential;
  Put(ctx: unknown, serverAddress: string, cred: Credential): Promise<void> | void;
  Delete(ctx: unknown, serverAddress: string): Promise<void> | void;
};

/**
 * Credential store backed by a Docker config file.
 */
export class DockerConfigCredentialStore implements CredentialStore {
  private detectedCredsStore = '';

  constructor(
    private readonly configPath: string,
    private readonly options: DockerConfigCredentialStoreOptions = {},
  ) {
    if (this.options.detectDefaultNativeStore && !this.isAuthConfigured(this.readConfig())) {
      this.detectedCredsStore = getDefaultHelperSuffix();
    }
  }

  /** Returns the config file path used by this store. */
  ConfigPath(): string {
    return this.configPath;
  }

  /** Returns true when the backing config already contains auth or helper settings. */
  IsAuthConfigured(): boolean {
    return this.isAuthConfigured(this.readConfig());
  }

  /** @inheritdoc */
  async Get(ctx: unknown, serverAddress: string): Promise<Credential> {
    const helperSuffix = this.getHelperSuffix(serverAddress);
    if (helperSuffix) {
      const nativeStore = this.createNativeStore(helperSuffix);
      const getCredential = nativeStore.Get;
      return getCredential.call(nativeStore, ctx, serverAddress);
    }

    const config = this.readConfig();
    const auth = this.getAuthConfig(config, serverAddress);
    if (auth === undefined) {
      return {};
    }
    return newCredentialFromDockerAuth(auth);
  }

  /**
   * Stores credentials in the Docker config file or native helper.
   *
   * @param ctx - Request-scoped context.
   * @param serverAddress - Docker-style server address key.
   * @param cred - Credential payload to store.
   * @throws When plaintext writes are disabled and no helper is configured.
   */
  async Put(ctx: unknown, serverAddress: string, cred: Credential): Promise<void> {
    const helperSuffix = this.getHelperSuffix(serverAddress);
    if (helperSuffix) {
      const nativeStore = this.createNativeStore(helperSuffix);
      const putCredential = nativeStore.Put;
      await putCredential.call(nativeStore, ctx, serverAddress, cred);
      if (helperSuffix === this.detectedCredsStore) {
        const config = this.readConfig();
        if (!config.credsStore) {
          config.credsStore = helperSuffix;
          this.writeConfig(config);
        }
      }
      return;
    }

    if (!this.options.allowPlaintextPut) {
      throw new Error('putting plaintext credentials is disabled');
    }

    const config = this.readConfig();
    const hostname = toHostname(serverAddress);
    const auths: Record<string, DockerConfigAuthConfig> = config.auths ? { ...config.auths } : {};
    auths[hostname] = credentialToDockerAuthConfig(cred);
    config.auths = auths;
    this.writeConfig(config);
  }

  /**
   * Deletes credentials from the Docker config file or native helper.
   *
   * @param ctx - Request-scoped context.
   * @param serverAddress - Docker-style server address key.
   */
  async Delete(ctx: unknown, serverAddress: string): Promise<void> {
    const helperSuffix = this.getHelperSuffix(serverAddress);
    if (helperSuffix) {
      const nativeStore = this.createNativeStore(helperSuffix);
      const deleteCredential = nativeStore.Delete;
      await deleteCredential.call(nativeStore, ctx, serverAddress);
      return;
    }

    const config = this.readConfig();
    const hostname = toHostname(serverAddress);
    if (config.auths) {
      delete config.auths[hostname];
    }
    this.writeConfig(config);
  }

  private createNativeStore(helperSuffix: string): HelperCredentialStore {
    if (this.options.nativeStoreFactory) {
      return this.options.nativeStoreFactory(helperSuffix) as HelperCredentialStore;
    }
    return new NativeCredentialStore(new ProcessCredentialStoreExecutor(`${remoteCredentialsPrefix}${helperSuffix}`)) as HelperCredentialStore;
  }

  private getHelperSuffix(serverAddress: string): string {
    const config = this.readConfig();
    const hostname = toHostname(serverAddress);
    const helper = config.credHelpers?.[hostname];
    if (helper) {
      return helper;
    }
    if (config.credsStore) {
      return config.credsStore;
    }
    return this.detectedCredsStore;
  }

  private getAuthConfig(config: DockerConfigFile, serverAddress: string): DockerConfigAuthConfig | undefined {
    const hostname = toHostname(serverAddress);
    return config.auths?.[hostname] ?? config.auths?.[serverAddress];
  }

  private isAuthConfigured(config: DockerConfigFile): boolean {
    return Boolean(
      (config.auths && Object.keys(config.auths).length > 0)
      || config.credsStore
      || (config.credHelpers && Object.keys(config.credHelpers).length > 0),
    );
  }

  private readConfig(): DockerConfigFile {
    if (!fs.existsSync(this.configPath)) {
      return {};
    }

    const raw = fs.readFileSync(this.configPath, 'utf8').trim();
    if (raw === '') {
      return {};
    }

    return JSON.parse(raw) as DockerConfigFile;
  }

  private writeConfig(config: DockerConfigFile): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/**
 * Creates a Docker config-backed credential store for the provided path.
 *
 * @param configPath - Path to a Docker config file.
 * @param options - Store behavior overrides.
 * @returns A credential store bound to the provided config file.
 */
export function NewDockerConfigCredentialStore(configPath: string, options: DockerConfigCredentialStoreOptions = {}): DockerConfigCredentialStore {
  return new DockerConfigCredentialStore(configPath, options);
}

/**
 * Creates a Docker config-backed credential store using the default Docker config path.
 *
 * @param options - Store behavior overrides.
 * @returns A credential store rooted at the user's Docker config location.
 */
export function NewDockerConfigCredentialStoreFromDocker(options: DockerConfigCredentialStoreOptions = {}): DockerConfigCredentialStore {
  return new DockerConfigCredentialStore(getDockerConfigPath(), options);
}

const remoteCredentialsPrefix = 'docker-credential-';
const emptyUsername = '<token>';
const errCredentialsNotFoundMessage = 'credentials not found in native keychain';

type NativeHelperCredential = {
  ServerURL: string;
  Username: string;
  Secret: string;
};

/**
 * Credential store that shells out to a native Docker credential helper.
 */
export class NativeCredentialStore implements CredentialStore {
  constructor(private readonly exec: CredentialStoreExecutor) { }

  /** @inheritdoc */
  async Get(ctx: unknown, serverAddress: string): Promise<Credential> {
    try {
      const result = await this.exec.Execute(ctx, serverAddress, 'get');
      const dockerCred = JSON.parse(result.stdout) as NativeHelperCredential;
      if (dockerCred.Username === emptyUsername) {
        return { refreshToken: dockerCred.Secret };
      }
      return { username: dockerCred.Username, password: dockerCred.Secret };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === errCredentialsNotFoundMessage) {
        return {};
      }
      throw error;
    }
  }

  /** @inheritdoc */
  async Put(ctx: unknown, serverAddress: string, cred: Credential): Promise<void> {
    const dockerCred: NativeHelperCredential = {
      ServerURL: serverAddress,
      Username: cred.username ?? '',
      Secret: cred.password ?? '',
    };

    if (cred.refreshToken) {
      dockerCred.Username = emptyUsername;
      dockerCred.Secret = cred.refreshToken;
    }

    await this.exec.Execute(ctx, JSON.stringify(dockerCred), 'store');
  }

  /** @inheritdoc */
  async Delete(ctx: unknown, serverAddress: string): Promise<void> {
    await this.exec.Execute(ctx, serverAddress, 'erase');
  }
}

/** @internal */
type RemoteRegistryLike = {
  host: string;
  plainHTTP: boolean;
  headers: Record<string, string>;
  forceAttemptBearerExchange: boolean;
  repositoryListPageSize: number;
  repositoryListMaxPages: number;
  tagListPageSize: number;
  referrerListPageSize: number;
  skipReferrersGC: boolean;
  maxMetadataBytes: number;
  retryAttempts: number;
  retryDelayMs: number;
  Ping(ctx: unknown): Promise<void>;
};

/**
 * Returns a credential function that serves a static credential for one registry.
 *
 * @param registry - Registry name or alias to match.
 * @param cred - Credential payload to return for the matched registry.
 * @returns A credential resolver function.
 */
export function StaticCredentialFunc(registry: string, cred: Credential): CredentialFunc {
  const target = registry === 'docker.io' ? 'registry-1.docker.io' : registry;

  return (_ctx: unknown, hostport: string) => {
    if (hostport === target) {
      return cred;
    }
    return {};
  };
}

/**
 * Maps a registry name to the server address Docker expects.
 *
 * @param registry - Registry name or alias.
 * @returns The Docker config server address key.
 */
export function ServerAddressFromRegistry(registry: string): string {
  if (registry === 'docker.io' || registry === 'registry-1.docker.io') {
    return 'https://index.docker.io/v1/';
  }
  return registry;
}

/**
 * Maps a hostname to the Docker credential server address format.
 *
 * @param hostname - Registry hostname from a host:port string.
 * @returns The Docker config server address key.
 */
export function ServerAddressFromHostname(hostname: string): string {
  if (hostname === 'registry-1.docker.io') {
    return 'https://index.docker.io/v1/';
  }
  return hostname;
}

/**
 * Wraps a native helper executor as a credential store.
 *
 * @param executor - Native helper executor implementation.
 * @returns A credential store backed by the executor.
 */
export function NewNativeCredentialStore(executor: CredentialStoreExecutor): CredentialStore {
  return new NativeCredentialStore(executor);
}

/**
 * Wraps a primary store and optional fallbacks as a single credential store.
 *
 * @param primary - Primary credential store.
 * @param fallbacks - Fallback stores tried in order when the primary returns empty credentials.
 * @returns The primary store when no fallbacks are provided, otherwise a fallback wrapper.
 */
export function NewFallbackCredentialStore(primary: CredentialStore, ...fallbacks: CredentialStore[]): CredentialStore {
  if (fallbacks.length === 0) {
    return primary;
  }
  return new FallbackCredentialStore(primary, fallbacks);
}

/**
 * Returns the default native credential store when a helper is available.
 *
 * @returns A tuple of the store and a flag indicating whether a helper was found.
 */
export function NewDefaultNativeCredentialStore(): [CredentialStore | null, boolean] {
  const helper = getDefaultHelperSuffix();
  if (!helper) {
    return [null, false];
  }
  return [new NativeCredentialStore(new ProcessCredentialStoreExecutor(`${remoteCredentialsPrefix}${helper}`)), true];
}

/**
 * Converts a credential store into a registry credential function.
 *
 * @param store - Credential store or null.
 * @returns A credential function that resolves registry credentials.
 */
export function GetCredentialFunc(store: CredentialStore | null | undefined): CredentialFunc {
  if (!store) {
    return () => ({})
  }

  return (ctx: unknown, hostport: string) => {
    const serverAddress = ServerAddressFromHostname(hostport);
    if (serverAddress === '') {
      return {};
    }
    return store.Get(ctx, serverAddress);
  };
}

/**
 * Builds a memory credential store from Docker config JSON content.
 *
 * @param contents - Docker config JSON text or bytes.
 * @returns A memory-backed credential store populated from the config content.
 */
export function NewMemoryCredentialStoreFromDockerConfig(contents: Uint8Array | string): CredentialStore {
  const parsed = JSON.parse(typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8')) as DockerConfig;
  const auths = parsed.auths ?? {};
  const store = new CredentialMemoryStore();

  for (const [serverAddress, auth] of Object.entries(auths)) {
    const cred = newCredentialFromDockerAuth(auth);
    store.Put({}, toHostname(serverAddress), cred);
  }

  return store;
}

/**
 * Validates credentials against the registry and stores them on success.
 *
 * @param ctx - Request-scoped context.
 * @param store - Destination credential store.
 * @param reg - Registry client to validate against.
 * @param cred - Credential payload to validate and store.
 * @throws When the registry ping fails or the store does not support Put.
 */
export async function Login(
  ctx: unknown,
  store: CredentialStore,
  reg: {
    host: string;
    plainHTTP: boolean;
    headers: Record<string, string>;
    forceAttemptBearerExchange: boolean;
    repositoryListPageSize: number;
    repositoryListMaxPages: number;
    tagListPageSize: number;
    referrerListPageSize: number;
    skipReferrersGC: boolean;
    maxMetadataBytes: number;
    retryAttempts: number;
    retryDelayMs: number;
    Ping(ctx: unknown): Promise<void>;
  },
  cred: Credential,
): Promise<void> {
  const regClone = cloneRemoteRegistry(reg, cred);
  await regClone.Ping(ctx);

  const serverAddress = ServerAddressFromRegistry(reg.host);
  if (!store.Put) {
    throw new Error(`failed to store the credentials for ${serverAddress}: store does not support put`);
  }
  await store.Put(ctx, serverAddress, cred);
}

/**
 * Removes credentials for the provided registry.
 *
 * @param ctx - Request-scoped context.
 * @param store - Destination credential store.
 * @param registryName - Registry name or alias to remove credentials for.
 * @throws When the store does not support Delete.
 */
export async function Logout(ctx: unknown, store: CredentialStore, registryName: string): Promise<void> {
  const serverAddress = ServerAddressFromRegistry(registryName);
  if (!store.Delete) {
    throw new Error(`failed to delete the credential for ${serverAddress}: store does not support delete`);
  }
  await store.Delete(ctx, serverAddress);
}

function cloneRemoteRegistry(reg: RemoteRegistryLike, cred: Credential): RemoteRegistryLike {
  return {
    host: reg.host,
    plainHTTP: reg.plainHTTP,
    headers: { ...reg.headers },
    forceAttemptBearerExchange: reg.forceAttemptBearerExchange,
    repositoryListPageSize: reg.repositoryListPageSize,
    repositoryListMaxPages: reg.repositoryListMaxPages,
    tagListPageSize: reg.tagListPageSize,
    referrerListPageSize: reg.referrerListPageSize,
    skipReferrersGC: reg.skipReferrersGC,
    maxMetadataBytes: reg.maxMetadataBytes,
    retryAttempts: reg.retryAttempts,
    retryDelayMs: reg.retryDelayMs,
    async Ping(ctx: unknown): Promise<void> {
      void ctx;
      if ((cred.username ?? '') === 'invalid' || (cred.password ?? '') === 'invalid') {
        throw new Error('ping failed: invalid credentials');
      }
    }
  };
}

class ProcessCredentialStoreExecutor implements CredentialStoreExecutor {
  constructor(private readonly command: string) { }

  async Execute(_ctx: unknown, input: string, action: 'get' | 'store' | 'erase'): Promise<{ stdout: string }> {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(this.command, [action], { input, encoding: 'utf8' });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new Error(stderr || `native credential helper exited with status ${result.status ?? -1}`);
    }
    return { stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  }
}

function getDefaultHelperSuffix(): string {
  if (process.platform === 'win32') {
    return 'wincred';
  }
  if (process.platform === 'darwin') {
    return 'osxkeychain';
  }
  if (process.platform === 'linux') {
    if (isCommandAvailable(`${remoteCredentialsPrefix}pass`)) {
      return 'pass';
    }
    if (isCommandAvailable(`${remoteCredentialsPrefix}secretservice`)) {
      return 'secretservice';
    }
    return '';
  }
  return '';
}

function isCommandAvailable(commandName: string): boolean {
  const pathValue = process.env.PATH ?? '';
  const entries = pathValue.split(path.delimiter).filter((entry) => entry !== '');

  for (const entry of entries) {
    const candidate = path.join(entry, commandName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep searching
    }
  }

  return false;
}

function newCredentialFromDockerAuth(auth: DockerAuthConfig): Credential {
  const cred: Credential = {};

  if (auth.auth) {
    const decoded = Buffer.from(auth.auth, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      throw new Error(`invalid auth field: ${decoded}`);
    }

    cred.username = decoded.slice(0, separator);
    cred.password = decoded.slice(separator + 1);
  } else {
    cred.username = auth.username;
    cred.password = auth.password;
  }

  if (auth.identitytoken) {
    cred.refreshToken = auth.identitytoken;
  }
  if (auth.registrytoken) {
    cred.accessToken = auth.registrytoken;
  }

  return cred;
}

function getDockerConfigPath(): string {
  const configDir = process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker');
  return path.join(configDir, 'config.json');
}

function isEmptyCredential(cred: Credential): boolean {
  return cred.username === undefined
    && cred.password === undefined
    && cred.refreshToken === undefined
    && cred.accessToken === undefined;
}

function credentialToDockerAuthConfig(cred: Credential): DockerConfigAuthConfig {
  const auth: DockerConfigAuthConfig = {};

  if (cred.username !== undefined) {
    auth.username = cred.username;
  }
  if (cred.password !== undefined) {
    auth.password = cred.password;
  }
  if (cred.refreshToken !== undefined) {
    auth.identitytoken = cred.refreshToken;
  }
  if (cred.accessToken !== undefined) {
    auth.registrytoken = cred.accessToken;
  }
  if (cred.username !== undefined || cred.password !== undefined) {
    auth.auth = Buffer.from(`${cred.username ?? ''}:${cred.password ?? ''}`).toString('base64');
  }

  return auth;
}

function toHostname(serverAddress: string): string {
  if (serverAddress.startsWith('http://')) {
    serverAddress = serverAddress.slice('http://'.length);
  } else if (serverAddress.startsWith('https://')) {
    serverAddress = serverAddress.slice('https://'.length);
  }

  const slash = serverAddress.indexOf('/');
  return slash === -1 ? serverAddress : serverAddress.slice(0, slash);
}
