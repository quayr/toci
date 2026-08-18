/**
 * MIME type used by OCI descriptors and manifests.
 */
export type OciMediaType = string;
/**
 * Digest algorithm name used in OCI digests.
 */
export type OciDigestAlgorithm = string;
/**
 * OCI digest string in the form `algorithm:encoded`.
 */
export type OciDigest = `${string}:${string}`;
/**
 * String-to-string annotation map.
 */
export type OciAnnotationMap = Record<string, string>;
/**
 * Content accepted when building OCI descriptors.
 */
export type OciContent = Uint8Array | string | object;

/**
 * Platform metadata attached to an OCI descriptor.
 */
export interface OciPlatform {
  /** CPU architecture such as amd64 or arm64. */
  architecture: string;
  /** Operating system such as linux or windows. */
  os: string;
  /** Optional OS version string. */
  osVersion?: string;
  /** Optional OS feature list. */
  osFeatures?: string[];
  /** Optional variant string such as v7. */
  variant?: string;
}

/**
 * Fully resolved OCI descriptor.
 */
export interface OciDescriptor {
  /** Descriptor media type. */
  mediaType: OciMediaType;
  /** Content digest in algorithm:encoded form. */
  digest: OciDigest;
  /** Content size in bytes. */
  size: number;
  /** Optional base64-encoded content payload. */
  data?: string;
  /** Optional descriptor annotations. */
  annotations?: OciAnnotationMap;
  /** Optional alternate URLs for the blob. */
  urls?: string[];
  /** Optional artifact type for referrers-aware manifests. */
  artifactType?: string;
  /** Optional platform metadata for multi-platform images. */
  platform?: OciPlatform;
}

/**
 * Input used to build an OCI descriptor.
 */
export interface OciDescriptorInput {
  /** Descriptor media type. */
  mediaType: OciMediaType;
  /** Content to hash and encode into the descriptor. */
  content: OciContent;
  /** Optional descriptor annotations. */
  annotations?: OciAnnotationMap;
}

/**
 * Descriptor input for OCI layers.
 */
export interface OciLayerInput extends OciDescriptorInput { }
/**
 * Descriptor input for OCI configs.
 */
export interface OciConfigInput extends OciDescriptorInput { }

/**
 * OCI image manifest media type.
 */
export const OCI_IMAGE_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
/**
 * OCI image index media type.
 */
export const OCI_IMAGE_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
/**
 * OCI empty config media type.
 */
export const OCI_EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
/**
 * OCI artifact manifest media type.
 */
export const OCI_ARTIFACT_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.artifact.manifest.v1+json';

/**
 * Valid OCI repository name pattern.
 */
export const OCI_REPOSITORY_NAME_REGEX =
  /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/;
/**
 * Valid OCI tag pattern.
 */
export const OCI_TAG_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
/**
 * Valid OCI digest pattern.
 */
export const OCI_DIGEST_REGEX = /^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z0-9]+)*:[0-9a-fA-F]{32,}$/;
/**
 * Valid OCI media type pattern.
 */
export const OCI_MEDIA_TYPE_REGEX = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/**
 * OCI image manifest payload.
 */
export interface OciImageManifest {
  /** Schema version, always 2. */
  schemaVersion: 2;
  /** Manifest media type. */
  mediaType: typeof OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  /** Config descriptor. */
  config: OciDescriptor;
  /** Layer descriptors. */
  layers: OciDescriptor[];
  /** Optional annotations. */
  annotations?: OciAnnotationMap;
  /** Optional subject descriptor. */
  subject?: OciDescriptor;
  /** Optional artifact type. */
  artifactType?: string;
}

/**
 * Input used to build an OCI image manifest.
 */
export interface OciImageManifestInput {
  /** Config descriptor input. */
  config: OciConfigInput;
  /** Layer descriptor inputs. */
  layers: OciLayerInput[];
  /** Optional annotations. */
  annotations?: OciAnnotationMap;
  /** Optional subject descriptor. */
  subject?: OciDescriptor;
  /** Optional artifact type. */
  artifactType?: string;
}

/**
 * OCI artifact manifest payload.
 */
export interface OciArtifactManifest {
  /** Schema version, always 2. */
  schemaVersion: 2;
  /** Manifest media type. */
  mediaType: typeof OCI_ARTIFACT_MANIFEST_MEDIA_TYPE;
  /** Artifact type string. */
  artifactType: string;
  /** Config descriptor. */
  config: OciDescriptor;
  /** Layer descriptors. */
  layers: OciDescriptor[];
  /** Optional annotations. */
  annotations?: OciAnnotationMap;
  /** Optional subject descriptor. */
  subject?: OciDescriptor;
}

/**
 * Alias for OCI artifact manifests used throughout the package.
 */
export type OciManifest = OciArtifactManifest;

/**
 * Input used to build an OCI artifact manifest.
 */
export interface OciArtifactInput {
  /** Artifact type string. */
  artifactType: string;
  /** Config descriptor input. */
  config: OciConfigInput;
  /** Layer descriptor inputs. */
  layers: OciLayerInput[];
  /** Optional annotations. */
  annotations?: OciAnnotationMap;
  /** Optional subject descriptor. */
  subject?: OciDescriptor;
}

/**
 * OCI image index payload.
 */
export interface OciImageIndex {
  /** Schema version, always 2. */
  schemaVersion: 2;
  /** Index media type. */
  mediaType: typeof OCI_IMAGE_INDEX_MEDIA_TYPE;
  /** Referenced manifest descriptors. */
  manifests: OciDescriptor[];
  /** Optional annotations. */
  annotations?: OciAnnotationMap;
  /** Optional subject descriptor. */
  subject?: OciDescriptor;
  /** Optional artifact type. */
  artifactType?: string;
}

/**
 * Input used to build an OCI image index.
 */
export interface OciImageIndexInput {
  /** Referenced manifest descriptors. */
  manifests: OciDescriptor[];
  /** Optional annotations. */
  annotations?: OciAnnotationMap;
  /** Optional subject descriptor. */
  subject?: OciDescriptor;
  /** Optional artifact type. */
  artifactType?: string;
}

/**
 * Query parameters used when uploading blobs.
 */
export interface OciBlobUploadQuery {
  /** Digest expected by the upload endpoint. */
  digest?: string;
  /** Digest algorithm to use during upload. */
  digestAlgorithm?: string;
  /** Source repository for mount or cross-repo upload. */
  from?: string;
  /** Blob digest to mount instead of uploading. */
  mount?: string;
}

/**
 * Query parameters used when listing tags.
 */
export interface OciTagsListQuery {
  /** Last tag returned by the previous page. */
  last?: string;
  /** Maximum number of tags requested. */
  n?: number;
}

/**
 * Parsed OCI digest components.
 */
export interface ParsedOciDigest {
  /** Digest algorithm name. */
  algorithm: string;
  /** Encoded digest payload. */
  encoded: string;
}

/**
 * Normalizes arbitrary OCI content to bytes.
 */
export function toOciBytes(content: OciContent): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (typeof content === 'string') {
    return utf8Encode(content);
  }
  return utf8Encode(JSON.stringify(content));
}

/**
 * Computes an OCI digest for the provided content.
 */
export function computeOciDigest(content: OciContent, algorithm: OciDigestAlgorithm = 'sha256'): OciDigest {
  const normalizedAlgorithm = algorithm.toLowerCase();
  if (normalizedAlgorithm !== 'sha256') {
    throw new Error(`Unsupported OCI digest algorithm: ${algorithm}`);
  }
  const hash = sha256Hex(toOciBytes(content));
  return `${normalizedAlgorithm}:${hash}`;
}

/**
 * Parses a validated OCI digest into its algorithm and encoded payload.
 */
export function parseOciDigest(value: string): ParsedOciDigest | null {
  if (!validateOciDigest(value)) {
    return null;
  }
  const separatorIndex = value.indexOf(':');
  return {
    algorithm: value.slice(0, separatorIndex),
    encoded: value.slice(separatorIndex + 1),
  };
}

/**
 * Determines whether a string is a valid OCI digest.
 */
export function validateOciDigest(value: string): value is OciDigest {
  return OCI_DIGEST_REGEX.test(value);
}

/**
 * Determines whether a string is a valid OCI media type.
 */
export function validateOciMediaType(value: string): boolean {
  return OCI_MEDIA_TYPE_REGEX.test(value);
}

/**
 * Determines whether a string is a valid OCI repository name.
 */
export function validateOciRepositoryName(value: string): boolean {
  return OCI_REPOSITORY_NAME_REGEX.test(value);
}

/**
 * Determines whether a string is a valid OCI tag.
 */
export function validateOciTag(value: string): boolean {
  return OCI_TAG_REGEX.test(value);
}

/**
 * Determines whether a string is a valid OCI reference.
 */
export function validateOciReference(value: string): boolean {
  return validateOciTag(value) || validateOciDigest(value);
}

/**
 * Validates that a value is a string-to-string annotation map.
 */
export function validateOciAnnotationMap(value: unknown): value is OciAnnotationMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof entry !== 'string') {
      return false;
    }
  }
  return true;
}

/**
 * Validates that a value is an OCI platform descriptor.
 */
export function validateOciPlatform(value: unknown): value is OciPlatform {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const platform = value as Partial<OciPlatform>;
  return typeof platform.architecture === 'string'
    && typeof platform.os === 'string'
    && (platform.osVersion === undefined || typeof platform.osVersion === 'string')
    && (platform.variant === undefined || typeof platform.variant === 'string')
    && (platform.osFeatures === undefined || (Array.isArray(platform.osFeatures) && platform.osFeatures.every(feature => typeof feature === 'string')));
}

function buildDescriptor(mediaType: string, content: OciContent, annotations?: OciAnnotationMap, extras: Partial<OciDescriptor> = {}): OciDescriptor {
  const bytes = toOciBytes(content);
  return {
    mediaType,
    digest: computeOciDigest(bytes),
    size: bytes.length,
    data: Buffer.from(bytes).toString('base64'),
    ...(annotations ? { annotations } : {}),
    ...extras,
  };
}

/**
 * Creates a fully populated OCI descriptor from content.
 *
 * @param input - Descriptor input.
 * @returns A descriptor with digest, size, and base64 data populated.
 */
export function createOciDescriptor(input: OciDescriptorInput): OciDescriptor {
  return buildDescriptor(input.mediaType, input.content, input.annotations);
}

/**
 * Creates an OCI artifact manifest.
 *
 * @param input - Artifact manifest input.
 * @returns A schema version 2 artifact manifest.
 */
export function createOciManifest(input: OciArtifactInput): OciManifest {
  return createOciArtifactManifest(input);
}

/**
 * Creates an OCI image manifest.
 *
 * @param input - Image manifest input.
 * @returns A schema version 2 image manifest.
 */
export function createOciImageManifest(input: OciImageManifestInput): OciImageManifest {
  const config = createOciDescriptor(input.config);
  const layers = input.layers.map(layer => createOciDescriptor(layer));
  return {
    schemaVersion: 2,
    mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    config,
    layers,
    ...(input.annotations ? { annotations: input.annotations } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.artifactType ? { artifactType: input.artifactType } : {}),
  };
}

/**
 * Creates an OCI artifact manifest.
 *
 * @param input - Artifact manifest input.
 * @returns A schema version 2 artifact manifest.
 */
export function createOciArtifactManifest(input: OciArtifactInput): OciArtifactManifest {
  const config = createOciDescriptor(input.config);
  const layers = input.layers.map(layer => createOciDescriptor(layer));
  return {
    schemaVersion: 2,
    mediaType: OCI_ARTIFACT_MANIFEST_MEDIA_TYPE,
    artifactType: input.artifactType,
    config,
    layers,
    ...(input.annotations ? { annotations: input.annotations } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
  };
}

/**
 * Creates an OCI image index.
 *
 * @param input - Image index input.
 * @returns A schema version 2 image index.
 */
export function createOciImageIndex(input: OciImageIndexInput): OciImageIndex {
  return {
    schemaVersion: 2,
    mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    manifests: input.manifests,
    ...(input.annotations ? { annotations: input.annotations } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.artifactType ? { artifactType: input.artifactType } : {}),
  };
}

/**
 * Alias for creating an OCI image index.
 *
 * @param input - Image index input.
 * @returns A schema version 2 image index.
 */
export function createOciIndex(input: OciImageIndexInput): OciImageIndex {
  return createOciImageIndex(input);
}

/**
 * Creates a referrers index from a list of descriptors.
 *
 * @param manifests - Referrer descriptors to include.
 * @returns A schema version 2 OCI image index.
 */
export function createOciReferrersIndex(manifests: OciDescriptor[]): OciImageIndex {
  return createOciImageIndex({ manifests: manifests ?? [] });
}

/**
 * Builds the tag used to store a referrers index for a digest.
 *
 * @param desc - Descriptor whose digest should be converted into a referrers tag.
 * @returns The referrers tag string.
 * @throws When the digest is malformed.
 */
export function createOciReferrersTag(desc: Pick<OciDescriptor, 'digest'>): string {
  const parsed = parseOciDigest(desc.digest);
  if (!parsed) {
    throw new Error(`invalid digest: ${desc.digest}`);
  }
  return `${parsed.algorithm}-${parsed.encoded}`;
}

/**
 * Determines whether a media type represents a manifest.
 *
 * @param mediaType - Media type string to test.
 * @returns True when the media type is recognized as a manifest.
 */
export function isManifestMediaType(mediaType: string): boolean {
  return mediaType === OCI_IMAGE_MANIFEST_MEDIA_TYPE
    || mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE
    || mediaType === OCI_ARTIFACT_MANIFEST_MEDIA_TYPE
    || mediaType === 'application/vnd.docker.distribution.manifest.v2+json'
    || mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json';
}

/**
 * Determines whether a media type represents a foreign layer.
 *
 * @param mediaType - Media type string to test.
 * @returns True when the media type represents a foreign layer.
 */
export function isForeignLayerMediaType(mediaType: string): boolean {
  return mediaType === 'application/vnd.oci.image.layer.nondistributable.v1.tar'
    || mediaType === 'application/vnd.oci.image.layer.nondistributable.v1.tar+gzip'
    || mediaType === 'application/vnd.oci.image.layer.nondistributable.v1.tar+zstd'
    || mediaType === 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip';
}

/**
 * Strips non-essential metadata from a descriptor.
 *
 * @param desc - Source descriptor.
 * @returns A descriptor containing only media type, digest, and size.
 */
export function plainDescriptor(desc: OciDescriptor): OciDescriptor {
  return {
    mediaType: desc.mediaType,
    digest: desc.digest,
    size: desc.size,
  };
}

/**
 * Alias for stripping non-essential metadata from a descriptor.
 *
 * @param desc - Source descriptor.
 * @returns A descriptor containing only media type, digest, and size.
 */
export function fromOciDescriptor(desc: OciDescriptor): OciDescriptor {
  return plainDescriptor(desc);
}

function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18));
      bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function sha256Hex(message: Uint8Array): string {
  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const h = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);

  const bitLength = message.length * 8;
  const paddedLength = ((message.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  for (let offset = paddedLength - 8; offset < paddedLength; offset += 1) {
    padded[offset] = (bitLength / 2 ** ((paddedLength - 1 - offset) * 8)) & 0xff;
  }

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let word = 0; word < 16; word += 1) {
      const index = offset + word * 4;
      w[word] = (padded[index] << 24)
        | (padded[index + 1] << 16)
        | (padded[index + 2] << 8)
        | padded[index + 3];
    }
    for (let word = 16; word < 64; word += 1) {
      const s0 = rotr(w[word - 15], 7) ^ rotr(w[word - 15], 18) ^ (w[word - 15] >>> 3);
      const s1 = rotr(w[word - 2], 17) ^ rotr(w[word - 2], 19) ^ (w[word - 2] >>> 10);
      w[word] = (((w[word - 16] + s0) | 0) + w[word - 7] + s1) | 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let i = h[7];

    for (let word = 0; word < 64; word += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((((i + s1) | 0) + ch) | 0) + k[word] + w[word]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      i = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + i) | 0;
  }

  return Array.from(h, word => word >>> 0)
    .map(word => [24, 16, 8, 0].map(shift => toHex((word >>> shift) & 0xff)).join(''))
    .join('');
}

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}
