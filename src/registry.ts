import { isManifestMediaType, plainDescriptor, type OciDescriptor } from './oci';

/**
 * Read-only access to graph data for OCI descriptors.
 */
export interface ReadOnlyGraphStorage {
  /**
   * Fetches the raw bytes for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to fetch.
   * @returns A readable stream for the descriptor content.
   */
  Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;
  /**
   * Checks whether a descriptor exists.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to check.
   * @returns True when the descriptor exists.
   */
  Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> | boolean;
  /**
   * Lists direct predecessors for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param node - Descriptor whose predecessors should be listed.
   * @returns Predecessor descriptors.
   */
  Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> | OciDescriptor[];
}

/**
 * Fetches a descriptor by reference.
 */
export interface ReferenceFetcher {
  /**
   * Resolves a reference and streams the underlying content.
   *
   * @param ctx - Request-scoped context.
   * @param reference - Tag or digest reference.
   * @returns A descriptor plus a readable stream for the content.
   */
  FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> | { desc: OciDescriptor; stream: NodeJS.ReadableStream };
}

/**
 * Pushes a descriptor and tags it with a reference.
 */
export interface ReferencePusher {
  /**
   * Pushes content and assigns a reference.
   *
   * @param ctx - Request-scoped context.
   * @param expected - Expected descriptor for the pushed content.
   * @param content - Content payload to push.
   * @param reference - Tag or digest reference to assign.
   */
  PushReference(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer, reference: string): Promise<void> | void;
}

/**
 * Lists referrers for a manifest.
 */
export interface ReferrerLister {
  /**
   * Streams referrers for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param desc - Subject descriptor.
   * @param artifactType - Optional artifact type filter.
   * @param fn - Callback that receives each page of referrers.
   */
  Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> | void;
}

/**
 * Lists tags for a repository.
 */
export interface TagLister {
  /**
   * Streams repository tags in lexical order.
   *
   * @param ctx - Request-scoped context.
   * @param last - Last tag from the previous page, or empty to start at the beginning.
   * @param fn - Callback that receives each page of tags.
   */
  Tags(ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> | void;
}

/**
 * Writable blob storage backed by a read-only graph.
 */
export interface BlobStore extends ReferenceFetcher {
  /**
   * Reads the raw blob bytes for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to fetch.
   * @returns A readable stream for the descriptor content.
   */
  Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;
  /**
   * Checks whether a descriptor exists.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to check.
   * @returns True when the descriptor exists.
   */
  Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> | boolean;
  /**
   * Lists direct predecessors for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param node - Descriptor whose predecessors should be listed.
   * @returns Predecessor descriptors.
   */
  Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> | OciDescriptor[];
  /**
   * Writes content for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param expected - Expected descriptor for the pushed content.
   * @param content - Content payload to push.
   */
  Push(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> | void;
  /**
   * Deletes content identified by a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to delete.
   */
  Delete(ctx: unknown, target: OciDescriptor): Promise<void> | void;
}

/**
 * Writable manifest storage with tag resolution.
 */
export interface ManifestStore extends BlobStore, TagLister {
  /**
   * Resolves a reference to a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param reference - Tag or digest reference.
   * @returns The resolved descriptor.
   */
  Resolve(ctx: unknown, reference: string): Promise<OciDescriptor> | OciDescriptor;
  /**
   * Assigns a tag to a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param desc - Descriptor to tag.
   * @param reference - Tag or digest reference to assign.
   */
  Tag(ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> | void;
}

/**
 * Full repository interface for OCI blobs, manifests, tags, and referrers.
 */
export interface Repository extends ManifestStore, ReferencePusher {
  /**
   * Streams referrers for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param desc - Subject descriptor.
   * @param artifactType - Optional artifact type filter.
   * @param fn - Callback that receives each page of referrers.
   */
  Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> | void;
  /** Returns the blob-only store view. */
  Blobs(): BlobStore;
  /** Returns the manifest-only store view. */
  Manifests(): ManifestStore;
}

/**
 * Read-only repository surface that still supports tag listing.
 */
export interface ReadOnlyGraphTarget extends TagLister {
  /**
   * Reads the raw blob bytes for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to fetch.
   * @returns A readable stream for the descriptor content.
   */
  Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;
  /**
   * Checks whether a descriptor exists.
   *
   * @param ctx - Request-scoped context.
   * @param target - Descriptor to check.
   * @returns True when the descriptor exists.
   */
  Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> | boolean;
  /**
   * Lists direct predecessors for a descriptor.
   *
   * @param ctx - Request-scoped context.
   * @param node - Descriptor whose predecessors should be listed.
   * @returns Predecessor descriptors.
   */
  Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> | OciDescriptor[];
}

/**
 * Collects every tag from a repository.
 *
 * @param ctx - Request-scoped context.
 * @param repo - Repository or tag lister.
 * @returns Every tag across all pages.
 */
export async function Tags(ctx: unknown, repo: TagLister): Promise<string[]> {
  const results: string[] = [];
  await repo.Tags(ctx, '', async (tags) => {
    results.push(...tags);
  });
  return results;
}

/**
 * Collects all referrers for a descriptor from either a referrer lister or a read-only graph.
 *
 * @param ctx - Request-scoped context.
 * @param store - Referrer lister or read-only graph store.
 * @param desc - Subject descriptor.
 * @param artifactType - Optional artifact type filter.
 * @returns All matching referrers.
 * @throws When the descriptor is not a manifest.
 */
export async function Referrers(
  ctx: unknown,
  store: {
    Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> | OciDescriptor[];
  } | {
    Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> | void;
  },
  desc: OciDescriptor,
  artifactType = '',
): Promise<OciDescriptor[]> {
  if (!isManifestMediaType(desc.mediaType)) {
    throw new Error(`the descriptor ${JSON.stringify(desc)} is not a manifest`);
  }

  if (isReferrerLister(store)) {
    const results: OciDescriptor[] = [];
    await store.Referrers(ctx, desc, artifactType, async (page) => {
      results.push(...page);
    });
    return results;
  }

  const predecessors = await store.Predecessors(ctx, desc);
  return predecessors
    .filter((node) => artifactType === '' || node.artifactType === artifactType)
    .map((node) => plainDescriptor(node));
}

function isReferrerLister(value: unknown): value is {
  Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> | void;
} {
  return typeof (value as { Referrers?: unknown }).Referrers === 'function';
}
