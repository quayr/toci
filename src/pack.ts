import {
  createOciDescriptor,
  plainDescriptor,
  toOciBytes,
  validateOciDigest,
  validateOciMediaType,
  type OciDescriptor,
  type OciImageManifest,
  type OciManifest
} from './oci';

/**
 * Media type used when no config media type is known.
 */
export const MediaTypeUnknownConfig = 'application/vnd.unknown.config.v1+json';
/**
 * Media type used when no artifact media type is known.
 */
export const MediaTypeUnknownArtifact = 'application/vnd.unknown.artifact.v1';
/**
 * OCI image manifest media type used by pack helpers.
 */
export const MediaTypeImageManifest = 'application/vnd.oci.image.manifest.v1+json';
/**
 * OCI artifact manifest media type used by pack helpers.
 */
export const MediaTypeArtifactManifest = 'application/vnd.oci.artifact.manifest.v1+json';

/**
 * Error used when a timestamp does not match RFC 3339.
 */
export const ErrInvalidDateTimeFormat = new Error('invalid date and time format');
/**
 * Error used when an artifact type is required but missing.
 */
export const ErrMissingArtifactType = new Error('missing artifact type');
/**
 * Error used when a requested operation is not supported.
 */
export const ErrUnsupported = new Error('unsupported operation');
/**
 * Error used when a media type is invalid.
 */
export const ErrInvalidMediaType = new Error('invalid media type');
/**
 * Error used when a digest is invalid.
 */
export const ErrInvalidDigest = new Error('invalid digest');

/**
 * Supported pack manifest versions.
 */
export enum PackManifestVersion {
  PackManifestVersion1_0 = 1,
  PackManifestVersion1_1 = 2,
}

/**
 * Options for packing a manifest-compatible artifact.
 */
export interface PackOptions {
  /** Optional subject descriptor to attach to the packed manifest. */
  Subject?: OciDescriptor;
  /** Optional annotations applied to the manifest payload. */
  ManifestAnnotations?: Record<string, string>;
  /** Forces Pack to build an image manifest instead of an artifact manifest. */
  PackImageManifest?: boolean;
  /** Optional config descriptor to reuse instead of generating one. */
  ConfigDescriptor?: OciDescriptor;
  /** Optional annotations applied to the config descriptor. */
  ConfigAnnotations?: Record<string, string>;
}

/**
 * Options for packing an OCI manifest.
 */
export interface PackManifestOptions {
  /** Optional subject descriptor to attach to the packed manifest. */
  Subject?: OciDescriptor;
  /** Optional layer descriptors to include in the manifest. */
  Layers?: OciDescriptor[];
  /** Optional annotations applied to the manifest payload. */
  ManifestAnnotations?: Record<string, string>;
  /** Optional config descriptor to reuse instead of generating one. */
  ConfigDescriptor?: OciDescriptor;
  /** Optional annotations applied to the config descriptor. */
  ConfigAnnotations?: Record<string, string>;
}

/** @internal */
export interface Pusher {
  /**
   * Writes a descriptor payload to the backing store.
   *
   * @param ctx - Request-scoped context.
   * @param expected - Expected descriptor for the pushed content.
   * @param content - Content payload to push.
   */
  Push(ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> | void;
}

const CREATED_IMAGE = 'org.opencontainers.image.created';
const CREATED_ARTIFACT = 'org.opencontainers.artifact.created';
const REF_NAME = 'org.opencontainers.image.ref.name';

/**
 * Packs blobs into either an artifact manifest or an image manifest.
 *
 * @param ctx - Request-scoped context.
 * @param pusher - Destination used to persist content.
 * @param artifactType - Artifact type to encode into the manifest.
 * @param blobs - Blob descriptors to include as layers.
 * @param opts - Packing options.
 * @returns The descriptor for the packed manifest.
 */
export async function Pack(ctx: unknown, pusher: { Push(ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> | void }, artifactType: string, blobs: OciDescriptor[], opts: PackOptions): Promise<OciDescriptor> {
  if (opts.PackImageManifest) {
    return packImageManifestV1_1_RC2(ctx, pusher, artifactType, blobs, opts);
  }
  return packArtifact(ctx, pusher, artifactType, blobs, opts);
}

/**
 * Packs a manifest using the requested manifest version.
 *
 * @param ctx - Request-scoped context.
 * @param pusher - Destination used to persist content.
 * @param packManifestVersion - Manifest format version to emit.
 * @param artifactType - Artifact type to encode into the manifest.
 * @param opts - Manifest packing options.
 * @returns The descriptor for the packed manifest.
 * @throws ErrUnsupported when the version is unknown.
 */
export async function PackManifest(ctx: unknown, pusher: { Push(ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> | void }, packManifestVersion: PackManifestVersion, artifactType: string, opts: PackManifestOptions): Promise<OciDescriptor> {
  switch (packManifestVersion) {
    case PackManifestVersion.PackManifestVersion1_0:
      return packImageManifestV1_0(ctx, pusher, artifactType, opts);
    case PackManifestVersion.PackManifestVersion1_1:
      return packImageManifestV1_1(ctx, pusher, artifactType, opts);
    default:
      throw ErrUnsupported;
  }
}

async function packArtifact(ctx: unknown, pusher: Pusher, artifactType: string, blobs: OciDescriptor[], opts: PackOptions): Promise<OciDescriptor> {
  const resolvedArtifactType = artifactType || MediaTypeUnknownArtifact;
  if (!validateOciMediaType(resolvedArtifactType)) {
    throw ErrInvalidMediaType;
  }
  if (opts.ConfigDescriptor !== undefined) {
    if (!validateOciMediaType(opts.ConfigDescriptor.mediaType)) {
      throw ErrInvalidMediaType;
    }
    if (!validateOciDigest(opts.ConfigDescriptor.digest)) {
      throw ErrInvalidDigest;
    }
  }

  const annotations = ensureAnnotationCreated(opts.ManifestAnnotations, CREATED_ARTIFACT);
  const config = opts.ConfigDescriptor ?? createOciDescriptor({ mediaType: MediaTypeUnknownConfig, content: '{}' });
  const manifest: OciManifest = {
    schemaVersion: 2,
    mediaType: MediaTypeArtifactManifest,
    artifactType: resolvedArtifactType,
    config: stripData(config),
    layers: blobs.map(stripData),
    ...(opts.Subject ? { subject: stripData(opts.Subject) } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
  await pushReferencedContent(ctx, pusher, config, blobs);
  return pushManifest(ctx, pusher, manifest, resolvedArtifactType, annotations);
}

async function packImageManifestV1_1_RC2(ctx: unknown, pusher: Pusher, artifactType: string, blobs: OciDescriptor[], opts: PackOptions): Promise<OciDescriptor> {
  const resolvedArtifactType = artifactType || MediaTypeUnknownConfig;
  const annotations = ensureAnnotationCreated(opts.ManifestAnnotations, CREATED_IMAGE);
  if (opts.ConfigDescriptor !== undefined) {
    if (!validateOciMediaType(opts.ConfigDescriptor.mediaType)) {
      throw ErrInvalidMediaType;
    }
    if (!validateOciDigest(opts.ConfigDescriptor.digest)) {
      throw ErrInvalidDigest;
    }
  }
  const config = opts.ConfigDescriptor ?? createOciDescriptor({ mediaType: resolvedArtifactType, content: '{}' });
  const manifest: OciImageManifest = {
    schemaVersion: 2,
    mediaType: MediaTypeImageManifest,
    config: stripData(config),
    layers: blobs.map(stripData),
    ...(opts.Subject ? { subject: stripData(opts.Subject) } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
  await pushReferencedContent(ctx, pusher, config, blobs);
  return pushManifest(ctx, pusher, manifest, resolvedArtifactType, annotations);
}

async function packImageManifestV1_0(ctx: unknown, pusher: Pusher, artifactType: string, opts: PackManifestOptions): Promise<OciDescriptor> {
  if (opts.Subject !== undefined) {
    throw ErrUnsupported;
  }
  const resolvedConfig = resolveConfigDescriptor(artifactType, opts.ConfigDescriptor, opts.ConfigAnnotations, MediaTypeUnknownConfig);
  if (!validateOciMediaType(resolvedConfig.mediaType)) {
    throw ErrInvalidMediaType;
  }
  const annotations = ensureAnnotationCreated(opts.ManifestAnnotations, CREATED_IMAGE);
  const manifest: OciImageManifest = {
    schemaVersion: 2,
    mediaType: MediaTypeImageManifest,
    config: stripData(resolvedConfig),
    layers: (opts.Layers ?? []).map(stripData),
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
  await pushReferencedContent(ctx, pusher, resolvedConfig, opts.Layers ?? []);
  return pushManifest(ctx, pusher, manifest, resolvedConfig.mediaType, annotations);
}

async function packImageManifestV1_1(ctx: unknown, pusher: Pusher, artifactType: string, opts: PackManifestOptions): Promise<OciDescriptor> {
  const resolvedConfig = resolveConfigDescriptor(artifactType, opts.ConfigDescriptor, opts.ConfigAnnotations, MediaTypeUnknownConfig);
  if (!artifactType && opts.ConfigDescriptor === undefined) {
    throw ErrMissingArtifactType;
  }
  const resolvedArtifactType = artifactType || resolvedConfig.mediaType;
  if (!validateOciMediaType(resolvedArtifactType)) {
    throw ErrInvalidMediaType;
  }
  const annotations = ensureAnnotationCreated(opts.ManifestAnnotations, CREATED_IMAGE);
  const manifest: OciImageManifest = {
    schemaVersion: 2,
    mediaType: MediaTypeImageManifest,
    artifactType: resolvedArtifactType,
    config: stripData(resolvedConfig),
    layers: (opts.Layers ?? []).map(stripData),
    ...(opts.Subject ? { subject: stripData(opts.Subject) } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
  await pushReferencedContent(ctx, pusher, resolvedConfig, opts.Layers ?? []);
  return pushManifest(ctx, pusher, manifest, resolvedArtifactType, annotations);
}

function resolveConfigDescriptor(artifactType: string, configDescriptor: OciDescriptor | undefined, configAnnotations: Record<string, string> | undefined, fallbackMediaType: string): OciDescriptor {
  if (configDescriptor !== undefined) {
    if (!validateOciMediaType(configDescriptor.mediaType)) {
      throw ErrInvalidMediaType;
    }
    if (!validateOciDigest(configDescriptor.digest)) {
      throw ErrInvalidDigest;
    }
    return {
      ...configDescriptor,
      ...(configAnnotations ? { annotations: configAnnotations } : {}),
    };
  }
  const mediaType = artifactType || fallbackMediaType;
  return createOciDescriptor({ mediaType, content: '{}', annotations: configAnnotations });
}

async function pushReferencedContent(ctx: unknown, pusher: Pusher, config: OciDescriptor, blobs: OciDescriptor[]): Promise<void> {
  if (config.data !== undefined) {
    await pusher.Push(ctx, plainDescriptor(config), decodeData(config.data));
  }
  for (const blob of blobs) {
    if (blob.data !== undefined) {
      await pusher.Push(ctx, plainDescriptor(blob), decodeData(blob.data));
    }
  }
}

async function pushManifest(ctx: unknown, pusher: Pusher, manifest: OciImageManifest | OciManifest, artifactType: string, annotations: Record<string, string>): Promise<OciDescriptor> {
  const bytes = toOciBytes(manifest);
  const desc = createOciDescriptor({ mediaType: manifest.mediaType, content: bytes, annotations });
  desc.artifactType = artifactType;
  await pusher.Push(ctx, desc, bytes);
  return desc;
}

function ensureAnnotationCreated(annotations: Record<string, string> | undefined, createdKey: string): Record<string, string> {
  const next = { ...(annotations ?? {}) };
  if (next[createdKey] === undefined) {
    next[createdKey] = new Date().toISOString();
  }
  if (!isRFC3339(next[createdKey])) {
    throw ErrInvalidDateTimeFormat;
  }
  return next;
}

function isRFC3339(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function stripData(desc: OciDescriptor): OciDescriptor {
  return plainDescriptor(desc);
}

function decodeData(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}
