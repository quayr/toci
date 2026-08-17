import { Readable } from 'node:stream';

import {
  createOciDescriptor,
  createOciImageIndex,
  createOciReferrersTag,
  isManifestMediaType,
  OCI_ARTIFACT_MANIFEST_MEDIA_TYPE,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  toOciBytes,
  validateOciDigest,
  validateOciReference,
  validateOciRepositoryName,
  type OciDescriptor,
  type OciImageIndex
} from './oci';
import type { BlobStore, ManifestStore, Repository } from './registry';
type ReferrersState = 'unknown' | 'supported' | 'unsupported';
type AuthScheme = 'basic' | 'bearer';

/**
 * Options for configuring a remote OCI registry client.
 */
export interface RemoteRegistryOptions {
  plainHTTP?: boolean;
  /**
   * URL path prefix prepended to every `/v2/...` request, e.g. `/api/registry`
   * when the registry is mounted behind a gateway. Server-provided paths
   * (e.g. upload `Location` headers) are resolved as-is — they already carry
   * any prefix the server chose.
   */
  basePath?: string;
  headers?: Record<string, string>;
  basicAuth?: {
    username: string;
    password: string;
  };
  refreshToken?: string;
  bearerToken?: string;
  forceAttemptBearerExchange?: boolean;
  repositoryListPageSize?: number;
  repositoryListMaxPages?: number;
  tagListPageSize?: number;
  referrerListPageSize?: number;
  skipReferrersGC?: boolean;
  maxMetadataBytes?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

/**
 * HTTP client and registry capability cache for a remote OCI registry.
 */
export class RemoteRegistry {
  private static readonly bearerTokenCache = new Map<string, string>();
  private static readonly authSchemeCache = new Map<string, AuthScheme>();
  static readonly defaultMaxMetadataBytes = 4 * 1024 * 1024;
  static readonly referrerSubjectCache = new Map<string, { subject: OciDescriptor; referrer: OciDescriptor }>();

  readonly host: string;
  readonly basePath: string;
  plainHTTP: boolean;
  headers: Record<string, string>;
  basicAuth?: {
    username: string;
    password: string;
  };
  refreshToken?: string;
  bearerToken?: string;
  forceAttemptBearerExchange: boolean;
  repositoryListPageSize: number;
  repositoryListMaxPages: number;
  tagListPageSize: number;
  referrerListPageSize: number;
  skipReferrersGC: boolean;
  maxMetadataBytes: number;
  retryAttempts: number;
  retryDelayMs: number;

  /**
   * Creates a remote registry client for the provided host.
   */
  constructor(host: string, options: RemoteRegistryOptions = {}) {
    if (!host || /\s/.test(host)) {
      throw new Error('invalid registry host');
    }
    this.host = host;
    this.basePath = normalizeBasePath(options.basePath);
    this.plainHTTP = options.plainHTTP ?? false;
    this.headers = { ...(options.headers ?? {}) };
    this.basicAuth = options.basicAuth;
    this.refreshToken = options.refreshToken;
    this.bearerToken = options.bearerToken ?? RemoteRegistry.cachedBearerToken(this.authCacheKey());
    this.forceAttemptBearerExchange = options.forceAttemptBearerExchange ?? false;
    this.repositoryListPageSize = options.repositoryListPageSize ?? 100;
    this.repositoryListMaxPages = options.repositoryListMaxPages ?? 0;
    this.tagListPageSize = options.tagListPageSize ?? 100;
    this.referrerListPageSize = options.referrerListPageSize ?? 100;
    this.skipReferrersGC = options.skipReferrersGC ?? false;
    this.maxMetadataBytes = options.maxMetadataBytes ?? RemoteRegistry.defaultMaxMetadataBytes;
    this.retryAttempts = options.retryAttempts ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 0;
  }

  /**
   * Checks whether the registry is reachable and responds as an OCI registry.
   */
  async Ping(_ctx: unknown): Promise<void> {
    const response = await this.request('GET', '/v2/');
    if (response.status === 404) {
      throw new Error('not found');
    }
    if (!response.ok) {
      throw new Error(`ping failed: ${response.status}`);
    }
  }

  /**
   * Streams repository names from the registry catalog.
   */
  async Repositories(ctx: unknown, last: string, fn: (repos: string[]) => Promise<void> | void): Promise<void> {
    let nextPath: string | null = `/v2/_catalog?n=${this.repositoryListPageSize}${last ? `&last=${encodeURIComponent(last)}` : ''}`;
    let pageCount = 0;
    while (nextPath) {
      pageCount += 1;
      if (this.repositoryListMaxPages > 0 && pageCount > this.repositoryListMaxPages) {
        throw new Error('too many pages');
      }
      const response = await this.request('GET', nextPath);
      if (!response.ok) {
        throw new Error(`repositories failed: ${response.status}`);
      }
      const payload = await readJsonWithLimit(response, this.maxMetadataBytes) as { repositories?: string[] };
      await fn(payload.repositories ?? []);
      nextPath = nextLink(response.headers.get('link'));
      if (nextPath && nextPath.startsWith('/')) {
        nextPath = nextPath;
      }
      void ctx;
    }
  }

  /**
   * Creates a repository client scoped to a repository name.
   */
  Repository(reference: string): Repository {
    return new RemoteRepository(this, reference);
  }

  private scheme(): string {
    return this.plainHTTP ? 'http' : 'https';
  }

  private authCacheKey(): string {
    return RemoteRegistry.normalizeHostKey(this.host, this.scheme());
  }

  private static cachedBearerToken(host: string): string | undefined {
    if (RemoteRegistry.authSchemeCache.get(host) !== 'bearer') {
      return undefined;
    }
    return RemoteRegistry.bearerTokenCache.get(host);
  }

  private static setCachedScheme(host: string, scheme: AuthScheme): void {
    RemoteRegistry.authSchemeCache.set(host, scheme);
    if (scheme === 'basic') {
      RemoteRegistry.bearerTokenCache.delete(host);
    }
  }

  private static setCachedBearerToken(host: string, token: string): void {
    RemoteRegistry.authSchemeCache.set(host, 'bearer');
    RemoteRegistry.bearerTokenCache.set(host, token);
  }

  private static normalizeHostKey(host: string, scheme: string): string {
    const parsed = new URL(`${scheme}://${host}`);
    return `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}`;
  }

  async request(method: string, path: string, body?: RequestInit['body'], headers: Record<string, string> = {}): Promise<Response> {
    // Server-provided paths (e.g. upload Location headers) already carry any
    // gateway prefix; only prefix client-constructed `/v2/...` requests.
    const requestPath = path.startsWith('/v2') ? `${this.basePath}${path}` : path;
    let url = new URL(requestPath, `${this.scheme()}://${this.host}`);
    const mergedHeaders = { ...this.headers, ...headers };
    this.applyAuthHeaders(mergedHeaders);

    for (let attempt = 0; attempt <= this.retryAttempts; attempt += 1) {
      const response = await fetch(url, { method, body, headers: mergedHeaders, redirect: 'manual' });

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return response;
        }

        const nextUrl = new URL(location, url);
        if (!sameHTTPOrigin(url, nextUrl)) {
          delete mergedHeaders.Authorization;
        }
        if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
          method = 'GET';
          body = undefined;
        }
        response.body?.cancel();
        url = nextUrl;
        continue;
      }

      if (!shouldRetry(response.status) || attempt === this.retryAttempts) {
        if (response.status !== 401) {
          return response;
        }

        if (!sameHTTPOrigin(new URL(`${this.scheme()}://${this.host}`), url)) {
          return response;
        }

        const challenge = response.headers.get('www-authenticate');
        if (parseBasicChallenge(challenge) && this.basicAuth) {
          RemoteRegistry.setCachedScheme(this.authCacheKey(), 'basic');
          mergedHeaders.Authorization = `Basic ${Buffer.from(`${this.basicAuth.username}:${this.basicAuth.password}`).toString('base64')}`;
          response.body?.cancel();
          return fetch(url, { method, body, headers: mergedHeaders, redirect: 'manual' });
        }

        const bearerChallenge = parseBearerChallenge(challenge);
        if (!bearerChallenge) {
          return response;
        }

        try {
          const exchange = await this.exchangeBearerToken(bearerChallenge);
          if (!exchange) {
            return response;
          }

          this.bearerToken = exchange;
          RemoteRegistry.setCachedBearerToken(this.authCacheKey(), exchange);
          mergedHeaders.Authorization = `Bearer ${exchange}`;
          response.body?.cancel();
          return fetch(url, { method, body, headers: mergedHeaders, redirect: 'manual' });
        } catch (error) {
          return Promise.reject(error);
        }
      }

      response.body?.cancel();
      await delay(retryDelayFromResponse(response) ?? this.retryDelayMs);
    }

    throw new Error(`request failed: ${method} ${url}`);
  }

  private applyAuthHeaders(headers: Record<string, string>): void {
    if (headers.Authorization) {
      return;
    }

    const cachedScheme = RemoteRegistry.authSchemeCache.get(this.authCacheKey());
    if (cachedScheme === 'bearer' && this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
      RemoteRegistry.setCachedBearerToken(this.authCacheKey(), this.bearerToken);
      return;
    }

    if (cachedScheme === 'basic' && this.basicAuth) {
      const token = Buffer.from(`${this.basicAuth.username}:${this.basicAuth.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
      return;
    }

    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
      RemoteRegistry.setCachedBearerToken(this.host, this.bearerToken);
      return;
    }

    if (this.basicAuth) {
      const token = Buffer.from(`${this.basicAuth.username}:${this.basicAuth.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
  }

  private async exchangeBearerToken(challenge: BearerChallenge): Promise<string | null> {
    const service = challenge.service ?? this.host;
    const scopes = challenge.scope ? challenge.scope.split(' ').filter(Boolean) : [];

    if (!this.basicAuth && !this.refreshToken && !this.forceAttemptBearerExchange) {
      return this.fetchDistributionToken(challenge.realm, service, scopes, '', '');
    }

    const realmUrl = new URL(challenge.realm, `${this.scheme()}://${this.host}`);
    if (this.refreshToken) {
      const form = new URLSearchParams();
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', this.refreshToken);
      form.set('service', challenge.service ?? this.host);
      if (challenge.scope) {
        form.set('scope', challenge.scope);
      }

      const tokenResponse = await fetch(realmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      });

      if (!tokenResponse.ok) {
        throw new Error(`failed to fetch bearer token: ${tokenResponse.status}`);
      }

      const payload = await tokenResponse.json() as { token?: string; access_token?: string };
      return payload.token ?? payload.access_token ?? null;
    }

    if (!this.basicAuth) {
      return null;
    }

    const tokenResponse = await fetch(realmUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: (() => {
        const form = new URLSearchParams();
        form.set('grant_type', 'password');
        form.set('username', this.basicAuth.username);
        form.set('password', this.basicAuth.password);
        form.set('service', challenge.service ?? this.host);
        if (challenge.scope) {
          form.set('scope', challenge.scope);
        }
        return form.toString();
      })(),
    });

    if (!tokenResponse.ok) {
      throw new Error(`failed to fetch bearer token: ${tokenResponse.status}`);
    }

    const payload = await tokenResponse.json() as { token?: string; access_token?: string };
    return payload.token ?? payload.access_token ?? null;
  }

  private async fetchDistributionToken(realm: string, service: string, scopes: string[], username: string, password: string): Promise<string | null> {
    const realmUrl = new URL(realm, `${this.scheme()}://${this.host}`);
    if (username || password) {
      realmUrl.searchParams.set('service', service);
    } else {
      realmUrl.searchParams.set('service', service);
    }
    for (const scope of scopes) {
      realmUrl.searchParams.append('scope', scope);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (username || password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    const response = await fetch(realmUrl, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(`failed to fetch bearer token: ${response.status}`);
    }

    const payload = await response.json() as { token?: string; access_token?: string };
    return payload.token ?? payload.access_token ?? null;
  }
}

/**
 * Bearer challenge parameters parsed from a WWW-Authenticate header.
 */
type BearerChallenge = {
  realm: string;
  service?: string;
  scope?: string;
};

function parseBasicChallenge(header: string | null): boolean {
  if (!header) {
    return false;
  }

  return header.trim().toLowerCase().startsWith('basic');
}

/**
 * Normalizes a registry base path: ensures a single leading slash and no
 * trailing slash. Returns '' for empty or root paths.
 */
function normalizeBasePath(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * OCI repository client backed by a remote registry.
 */
/** @internal */
export class RemoteRepository implements Repository {
  readonly registry: RemoteRegistry;
  readonly name: string;
  private referrersState: ReferrersState = 'unknown';

  /**
   * Creates a repository client for the given registry and repository name.
   */
  constructor(registry: RemoteRegistry, name: string) {
    if (!validateOciRepositoryName(name)) {
      throw new Error('invalid repository name');
    }
    this.registry = registry;
    this.name = name;
  }

  /**
   * Locks the repository's referrers capability to the provided state.
   */
  SetReferrersCapability(capable: boolean): void {
    const nextState: ReferrersState = capable ? 'supported' : 'unsupported';
    if (this.referrersState === 'unknown') {
      this.referrersState = nextState;
      return;
    }
    if (this.referrersState !== nextState) {
      throw new Error('referrers capability cannot be changed once set');
    }
  }

  async Fetch(_ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    const path = isManifestMediaType(target.mediaType)
      ? this.manifestPath(target.digest)
      : this.blobPath(target.digest);
    const response = await this.registry.request('GET', path, undefined, isManifestMediaType(target.mediaType)
      ? { Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.oci.artifact.manifest.v1+json' }
      : {});
    if (!response.ok || !response.body) {
      throw new Error(`fetch failed: ${response.status}`);
    }
    return Readable.fromWeb(response.body as never);
  }

  async Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> {
    try {
      await this.Resolve(ctx, target.digest);
      return true;
    } catch {
      return false;
    }
  }

  async Push(_ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    if (isManifestMediaType(expected.mediaType)) {
      await this.PushReference({}, expected, content, expected.digest);
      return;
    }
    const bytes = await toBytes(content);
    const upload = await this.registry.request('POST', this.blobUploadPath());
    const location = upload.headers.get('location');
    if (!location) {
      throw new Error(`missing upload location (HTTP ${upload.status})`);
    }
    const put = await this.registry.request('PUT', `${location}${location.includes('?') ? '&' : '?'}digest=${encodeURIComponent(expected.digest)}`, bytes, {
      'Content-Type': expected.mediaType,
    });
    if (!put.ok) {
      throw new Error(`blob push failed: ${put.status}`);
    }
  }

  async Delete(_ctx: unknown, target: OciDescriptor): Promise<void> {
    if (isManifestMediaType(target.mediaType)) {
      await this.deleteManifestWithIndexing(target);
      return;
    }

    const response = await this.registry.request('DELETE', this.blobPath(target.digest));
    if (!response.ok) {
      throw new Error(`delete failed: ${response.status}`);
    }
  }

  async Resolve(_ctx: unknown, reference: string): Promise<OciDescriptor> {
    const response = await this.registry.request('HEAD', this.manifestPath(reference), undefined, {
      Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.oci.artifact.manifest.v1+json',
    });
    if (!response.ok) {
      throw new Error(`resolve failed: ${response.status}`);
    }
    return descriptorFromHeaders(response.headers);
  }

  async Tag(ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> {
    const fetched = await this.Fetch(ctx, desc);
    const bytes = await streamToBytes(fetched);
    const response = await this.registry.request('PUT', this.manifestPath(reference), bytes, {
      'Content-Type': desc.mediaType,
    });
    if (!response.ok) {
      throw new Error(`tag failed: ${response.status}`);
    }
  }

  async PushReference(_ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer, reference: string): Promise<void> {
    if (isManifestMediaType(expected.mediaType)) {
      await this.pushManifestWithIndexing(expected, content, reference);
      return;
    }

    const bytes = await toBytes(content);
    const response = await this.registry.request('PUT', this.manifestPath(reference), bytes, {
      'Content-Type': expected.mediaType,
    });
    if (!response.ok) {
      throw new Error(`push reference failed: ${response.status}`);
    }
  }

  async FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    const desc = await this.Resolve(ctx, reference);
    return { desc, stream: await this.Fetch(ctx, desc) };
  }

  async Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    if (this.referrersState === 'unsupported') {
      await this.referrersByTagSchema(ctx, desc, artifactType, fn);
      return;
    }

    const supported = await this.referrersByAPI(ctx, desc, artifactType, fn);
    if (supported) {
      this.SetReferrersCapability(true);
      return;
    }

    this.SetReferrersCapability(false);
    await this.referrersByTagSchema(ctx, desc, artifactType, fn);
  }

  async Tags(_ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    const response = await this.registry.request('GET', `/v2/${this.name}/tags/list?n=${this.registry.tagListPageSize}${last ? `&last=${encodeURIComponent(last)}` : ''}`);
    if (!response.ok) {
      throw new Error(`tags failed: ${response.status}`);
    }
    const payload = await response.json() as { tags?: string[] };
    await fn(payload.tags ?? []);
  }

  async Predecessors(_ctx: unknown, desc: OciDescriptor): Promise<OciDescriptor[]> {
    const response = await this.registry.request('GET', `/v2/${this.name}/referrers/${desc.digest}?n=${this.registry.referrerListPageSize}`);
    if (!response.ok) {
      return [];
    }
    const payload = await response.json() as OciImageIndex;
    return (payload.manifests ?? []).map((entry) => ({ ...entry }));
  }

  Blobs(): BlobStore {
    return this;
  }

  Manifests(): ManifestStore {
    return this;
  }

  private async referrersByAPI(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<boolean> {
    const reference = desc.digest;
    let nextPath: string | null = `/v2/${this.name}/referrers/${reference}?n=${this.registry.referrerListPageSize}${artifactType ? `&artifactType=${encodeURIComponent(artifactType)}` : ''}`;
    while (nextPath) {
      const response = await this.registry.request('GET', nextPath);
      if (response.status === 404) {
        return false;
      }
      if (!response.ok) {
        throw new Error(`referrers failed: ${response.status}`);
      }
      const payload = await readJsonWithLimit(response, this.registry.maxMetadataBytes) as OciImageIndex;
      const page = (payload.manifests ?? []).map((entry) => ({ ...entry }));
      await fn(artifactType ? page.filter((entry) => entry.artifactType === artifactType) : page);
      nextPath = nextLink(response.headers.get('link'));
      void ctx;
    }
    return true;
  }

  private async referrersByTagSchema(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    const referrersTag = createOciReferrersTag(desc);
    const response = await this.registry.request('GET', this.manifestPath(referrersTag));
    if (!response.ok) {
      if (response.status === 404) {
        await fn([]);
        return;
      }
      throw new Error(`referrers tag lookup failed: ${response.status}`);
    }
    const payload = await readJsonWithLimit(response, this.registry.maxMetadataBytes) as OciImageIndex;
    const manifests = (payload.manifests ?? []).map((entry) => ({ ...entry }));
    await fn(artifactType ? manifests.filter((entry) => entry.artifactType === artifactType) : manifests);
    void ctx;
  }

  private async pushManifestWithIndexing(expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer, reference: string): Promise<void> {
    const bytes = await toBytes(content);
    const response = await this.registry.request('PUT', this.manifestPath(reference), bytes, {
      'Content-Type': expected.mediaType,
    });
    if (!response.ok) {
      throw new Error(`push reference failed: ${response.status}`);
    }

    if (response.headers.get('oci-subject')) {
      this.setReferrersSupported();
      return;
    }

    const parsed = parseReferrerManifest(expected, bytes);
    if (!parsed?.subject) {
      return;
    }

    RemoteRegistry.referrerSubjectCache.set(expected.digest, parsed as { subject: OciDescriptor; referrer: OciDescriptor });

    await this.updateReferrersIndex(parsed.subject, { operation: 'add', referrer: parsed.referrer });
  }

  private async deleteManifestWithIndexing(target: OciDescriptor): Promise<void> {
    const fetchResponse = await this.registry.request('GET', this.manifestPath(target.digest), undefined, {
      Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.oci.artifact.manifest.v1+json',
    });
    if (!fetchResponse.ok) {
      throw new Error(`delete failed: ${fetchResponse.status}`);
    }

    const manifestBytes = await readJsonWithLimit(fetchResponse, this.registry.maxMetadataBytes);
    const response = await this.registry.request('DELETE', this.manifestPath(target.digest));
    if (!response.ok) {
      throw new Error(`delete failed: ${response.status}`);
    }

    const parsed = RemoteRegistry.referrerSubjectCache.get(target.digest) ?? parseReferrerManifest(target, manifestBytes as Uint8Array | object);
    if (!parsed?.subject) {
      return;
    }

    RemoteRegistry.referrerSubjectCache.delete(target.digest);

    await this.updateReferrersIndex(parsed.subject, { operation: 'remove', referrer: parsed.referrer });
  }

  private async updateReferrersIndex(subject: OciDescriptor, change: { operation: 'add' | 'remove'; referrer: OciDescriptor }): Promise<void> {
    const referrersTag = createOciReferrersTag(subject);
    const current = await this.fetchReferrersIndex(referrersTag);
    const referrerMap = new Map<string, OciDescriptor>();
    for (const referrer of current.referrers) {
      referrerMap.set(referrer.digest, referrer);
    }

    if (change.operation === 'add') {
      referrerMap.set(change.referrer.digest, change.referrer);
    } else {
      referrerMap.delete(change.referrer.digest);
    }

    const updatedReferrers = [...referrerMap.values()];
    if (updatedReferrers.length === 0 && !this.registry.skipReferrersGC) {
      if (current.indexDesc) {
        const deleteResponse = await this.registry.request('DELETE', this.manifestPath(current.indexDesc.digest));
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          throw new Error(`failed to delete dangling referrers index ${current.indexDesc.digest} for referrers tag ${referrersTag}: ${deleteResponse.status}`);
        }
      }
      return;
    }

    const index = createOciImageIndex({ manifests: updatedReferrers });
    const indexBytes = toOciBytes(index);
    const indexDesc = createOciDescriptor({ mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE, content: index });
    const putResponse = await this.registry.request('PUT', this.manifestPath(referrersTag), indexBytes, {
      'Content-Type': OCI_IMAGE_INDEX_MEDIA_TYPE,
    });
    if (!putResponse.ok) {
      throw new Error(`failed to push referrers index tagged by ${referrersTag}: ${putResponse.status}`);
    }

    if (!this.registry.skipReferrersGC && current.indexDesc && current.indexDesc.digest !== indexDesc.digest) {
      const deleteResponse = await this.registry.request('DELETE', this.manifestPath(current.indexDesc.digest));
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`failed to delete dangling referrers index ${current.indexDesc.digest} for referrers tag ${referrersTag}: ${deleteResponse.status}`);
      }
    }
  }

  private async fetchReferrersIndex(referrersTag: string): Promise<{ indexDesc: OciDescriptor | null; referrers: OciDescriptor[] }> {
    const response = await this.registry.request('GET', this.manifestPath(referrersTag));
    if (response.status === 404) {
      return { indexDesc: null, referrers: [] };
    }
    if (!response.ok) {
      throw new Error(`referrers tag lookup failed: ${response.status}`);
    }

    const indexDesc = descriptorFromHeaders(response.headers);
    const payload = await readJsonWithLimit(response, this.registry.maxMetadataBytes) as Partial<OciImageIndex>;
    return {
      indexDesc,
      referrers: (payload.manifests ?? []).map((entry) => ({ ...entry })),
    };
  }

  private setReferrersSupported(): void {
    if (this.referrersState === 'unknown') {
      this.referrersState = 'supported';
    }
  }

  private blobUploadPath(): string {
    return `/v2/${this.name}/blobs/uploads/`;
  }

  private blobPath(digest: string): string {
    return `/v2/${this.name}/blobs/${digest}`;
  }

  private manifestPath(reference: string): string {
    if (!validateOciReference(reference)) {
      throw new Error('invalid reference');
    }
    return `/v2/${this.name}/manifests/${reference}`;
  }
}

function parseReferrerManifest(expected: OciDescriptor, manifestBytes: Uint8Array | object): { subject?: OciDescriptor; referrer: OciDescriptor } | null {
  const manifest = typeof manifestBytes === 'object' && !(manifestBytes instanceof Uint8Array)
    ? manifestBytes as Record<string, unknown>
    : JSON.parse(Buffer.from(manifestBytes as Uint8Array).toString('utf8')) as Record<string, unknown>;

  if (expected.mediaType === OCI_ARTIFACT_MANIFEST_MEDIA_TYPE) {
    const subject = manifest.subject as OciDescriptor | undefined;
    if (!subject) {
      return null;
    }
    return {
      subject,
      referrer: {
        ...expected,
        artifactType: typeof manifest.artifactType === 'string' ? manifest.artifactType : expected.artifactType,
        annotations: isRecordOfStrings(manifest.annotations) ? manifest.annotations : expected.annotations,
      },
    };
  }

  if (expected.mediaType === OCI_IMAGE_MANIFEST_MEDIA_TYPE) {
    const subject = manifest.subject as OciDescriptor | undefined;
    if (!subject) {
      return null;
    }
    const config = manifest.config as OciDescriptor | undefined;
    return {
      subject,
      referrer: {
        ...expected,
        artifactType: typeof manifest.artifactType === 'string'
          ? manifest.artifactType
          : config?.mediaType ?? expected.artifactType,
        annotations: isRecordOfStrings(manifest.annotations) ? manifest.annotations : expected.annotations,
      },
    };
  }

  if (expected.mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE) {
    const subject = manifest.subject as OciDescriptor | undefined;
    if (!subject) {
      return null;
    }
    return {
      subject,
      referrer: {
        ...expected,
        artifactType: typeof manifest.artifactType === 'string' ? manifest.artifactType : expected.artifactType,
        annotations: isRecordOfStrings(manifest.annotations) ? manifest.annotations : expected.annotations,
      },
    };
  }

  return null;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match?.[1] ?? null;
}

function parseBearerChallenge(header: string | null): BearerChallenge | null {
  if (!header || !/^Bearer\s+/i.test(header)) {
    return null;
  }

  const params = new Map<string, string>();
  const parts = header.replace(/^Bearer\s+/i, '').split(',');
  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=', 2);
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue?.trim().replace(/^"|"$/g, '');
    if (key && value) {
      params.set(key, value);
    }
  }

  const realm = params.get('realm');
  if (!realm) {
    return null;
  }

  return {
    realm,
    service: params.get('service') ?? undefined,
    scope: params.get('scope') ?? undefined,
  };
}

function sameHTTPOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && canonicalHost(a) === canonicalHost(b);
}

function canonicalHost(u: URL): string {
  const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
  return `${u.hostname.toLowerCase()}:${port}`;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status === 503;
}

function retryDelayFromResponse(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJsonWithLimit(response: Response, maxMetadataBytes: number): Promise<unknown> {
  if (!response.body) {
    return {};
  }

  const limit = maxMetadataBytes > 0 ? maxMetadataBytes : RemoteRegistry.defaultMaxMetadataBytes;
  const stream = Readable.fromWeb(response.body as never);
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream as AsyncIterable<Uint8Array | Buffer>) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error(`content size ${size} exceeds MaxMetadataBytes ${limit}`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function descriptorFromHeaders(headers: Headers): OciDescriptor {
  const mediaType = headers.get('content-type') ?? 'application/octet-stream';
  const digest = headers.get('docker-content-digest') ?? headers.get('digest');
  const sizeHeader = headers.get('content-length');
  if (!digest || !validateOciDigest(digest)) {
    throw new Error('missing digest');
  }
  return {
    mediaType,
    digest,
    size: sizeHeader ? Number(sizeHeader) : 0,
  };
}

async function toBytes(content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (typeof (content as NodeJS.ReadableStream).read === 'function') {
    return streamToBytes(content as NodeJS.ReadableStream);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of content as AsyncIterable<Uint8Array | Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function streamToBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array | Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export type RemoteBlobStore = RemoteRepository;
/**
 * Alias for a remote manifest store.
 */
export type RemoteManifestStore = RemoteRepository;
/**
 * Alias for a remote read-only graph target.
 */
export type RemoteReadOnlyGraphTarget = RemoteRepository;
/**
 * Alias for a remote tag lister.
 */
export type RemoteTagLister = RemoteRepository;
/**
 * Alias for a remote referrer lister.
 */
export type RemoteReferrerLister = RemoteRepository;
