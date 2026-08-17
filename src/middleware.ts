import type { OciDescriptor } from './oci';
import type { BlobStore, ManifestStore, Repository } from './registry';

/**
 * Evaluates whether a reference is allowed by policy.
 */
export interface PolicyEnforcer {
  allows(reference: string): Promise<boolean> | boolean;
}

/**
 * Wraps a repository with middleware and returns the decorated repository.
 */
export interface RepositoryMiddleware {
  (repo: Repository): Repository;
}

/**
 * Creates a repository decorator that enforces policy checks on read and write operations.
 */
export function WithPolicyEnforcement(enforcer: PolicyEnforcer | null | undefined): RepositoryMiddleware {
  if (!enforcer) {
    return (repo: Repository) => repo;
  }

  return (repo: Repository) => new PolicyEnforcingRepository(repo, enforcer);
}

class PolicyEnforcingRepository implements Repository {
  constructor(private readonly repo: Repository, private readonly enforcer: PolicyEnforcer) { }

  async Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Fetch(ctx, target);
  }

  async Push(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    await this.checkPolicy(ctx, expected.digest);
    return this.repo.Push(ctx, expected, content);
  }

  async PushReference(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer, reference: string): Promise<void> {
    await this.checkPolicy(ctx, reference);
    return this.repo.PushReference(ctx, expected, content, reference);
  }

  async Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Exists(ctx, target);
  }

  async Delete(ctx: unknown, target: OciDescriptor): Promise<void> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Delete(ctx, target);
  }

  async Resolve(ctx: unknown, reference: string): Promise<OciDescriptor> {
    await this.checkPolicy(ctx, reference);
    return this.repo.Resolve(ctx, reference);
  }

  async Tag(ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> {
    await this.checkPolicy(ctx, reference);
    return this.repo.Tag(ctx, desc, reference);
  }

  async FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    await this.checkPolicy(ctx, reference);
    return this.repo.FetchReference(ctx, reference);
  }

  async Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    return this.repo.Referrers(ctx, desc, artifactType, fn);
  }

  async Tags(ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    return this.repo.Tags(ctx, last, fn);
  }

  async Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    await this.checkPolicy(ctx, node.digest);
    return this.repo.Predecessors(ctx, node);
  }

  Blobs() {
    return new PolicyEnforcingBlobStore(this.repo.Blobs(), this.enforcer);
  }

  Manifests() {
    return new PolicyEnforcingManifestStore(this.repo.Manifests(), this.enforcer);
  }

  private async checkPolicy(_ctx: unknown, reference: string): Promise<void> {
    const allowed = await this.enforcer.allows(reference);
    if (!allowed) {
      throw new Error(`access denied by policy for ${reference}`);
    }
  }
}

class PolicyEnforcingBlobStore implements BlobStore {
  constructor(protected readonly repo: BlobStore, protected readonly enforcer: PolicyEnforcer) { }

  async Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Fetch(ctx, target);
  }

  async Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Exists(ctx, target);
  }

  async Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    await this.checkPolicy(ctx, node.digest);
    return this.repo.Predecessors(ctx, node);
  }

  async FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    await this.checkPolicy(ctx, reference);
    return this.repo.FetchReference(ctx, reference);
  }

  async Push(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    await this.checkPolicy(ctx, expected.digest);
    return this.repo.Push(ctx, expected, content);
  }

  async Delete(ctx: unknown, target: OciDescriptor): Promise<void> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Delete(ctx, target);
  }

  Blobs(): BlobStore {
    return this;
  }

  Manifests(): ManifestStore {
    return this.repo as unknown as ManifestStore;
  }

  async checkPolicy(_ctx: unknown, reference: string): Promise<void> {
    const allowed = await this.enforcer.allows(reference);
    if (!allowed) {
      throw new Error(`access denied by policy for ${reference}`);
    }
  }
}

class PolicyEnforcingManifestStore implements ManifestStore {
  constructor(private readonly repo: ManifestStore, private readonly enforcer: PolicyEnforcer) { }

  async Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Fetch(ctx, target);
  }

  async Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Exists(ctx, target);
  }

  async Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    await this.checkPolicy(ctx, node.digest);
    return this.repo.Predecessors(ctx, node);
  }

  async FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    await this.checkPolicy(ctx, reference);
    return this.repo.FetchReference(ctx, reference);
  }

  async Push(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    await this.checkPolicy(ctx, expected.digest);
    return this.repo.Push(ctx, expected, content);
  }

  async Delete(ctx: unknown, target: OciDescriptor): Promise<void> {
    await this.checkPolicy(ctx, target.digest);
    return this.repo.Delete(ctx, target);
  }

  async Resolve(ctx: unknown, reference: string): Promise<OciDescriptor> {
    await this.checkPolicy(ctx, reference);
    return this.repo.Resolve(ctx, reference);
  }

  async Tag(ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> {
    await this.checkPolicy(ctx, reference);
    return this.repo.Tag(ctx, desc, reference);
  }

  async Tags(ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    return this.repo.Tags(ctx, last, fn);
  }

  private async checkPolicy(_ctx: unknown, reference: string): Promise<void> {
    const allowed = await this.enforcer.allows(reference);
    if (!allowed) {
      throw new Error(`access denied by policy for ${reference}`);
    }
  }
}

/**
 * Creates a policy enforcer that allows every reference.
 */
export function createAllowAllPolicy(): PolicyEnforcer {
  return {
    async allows() {
      return true;
    },
  };
}

/**
 * Creates a policy enforcer that denies every reference.
 */
export function createDenyAllPolicy(): PolicyEnforcer {
  return {
    async allows() {
      return false;
    },
  };
}
