/**
 * Public entry point for the toci package.
 */
export {
  CredentialMemoryStore, DockerConfigCredentialStore, GetCredentialFunc,
  Login,
  Logout,
  NewDefaultNativeCredentialStore, NewDockerConfigCredentialStore, NewDockerConfigCredentialStoreFromDocker, NewMemoryCredentialStoreFromDockerConfig, NewNativeCredentialStore, ServerAddressFromHostname,
  ServerAddressFromRegistry,
  StaticCredentialFunc,
  type Credential,
  type CredentialFunc, type CredentialStore, type CredentialStoreExecutor, type DockerConfigCredentialStoreOptions
} from './auth';
export { manifests, subject } from './manifestutil';
export { MemoryStore, type MemoryStoreOptions } from './memory';
export {
  createAllowAllPolicy,
  createDenyAllPolicy, WithPolicyEnforcement, type PolicyEnforcer,
  type RepositoryMiddleware
} from './middleware';
export {
  computeOciDigest,
  createOciArtifactManifest,
  createOciDescriptor,
  createOciImageIndex,
  createOciImageManifest,
  createOciIndex,
  createOciManifest,
  createOciReferrersIndex,
  createOciReferrersTag,
  fromOciDescriptor,
  isForeignLayerMediaType,
  isManifestMediaType, OCI_ARTIFACT_MANIFEST_MEDIA_TYPE,
  OCI_DIGEST_REGEX,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  OCI_MEDIA_TYPE_REGEX,
  OCI_REPOSITORY_NAME_REGEX,
  OCI_TAG_REGEX, parseOciDigest,
  plainDescriptor,
  toOciBytes,
  validateOciAnnotationMap,
  validateOciDigest,
  validateOciMediaType,
  validateOciPlatform,
  validateOciReference,
  validateOciRepositoryName,
  validateOciTag,
  type OciAnnotationMap,
  type OciArtifactInput,
  type OciArtifactManifest,
  type OciBlobUploadQuery,
  type OciConfigInput,
  type OciContent,
  type OciDescriptor,
  type OciDescriptorInput,
  type OciDigest,
  type OciDigestAlgorithm,
  type OciImageIndex,
  type OciImageIndexInput,
  type OciImageManifest,
  type OciImageManifestInput,
  type OciLayerInput,
  type OciManifest,
  type OciMediaType,
  type OciPlatform,
  type OciTagsListQuery,
  type ParsedOciDigest
} from './oci';
export {
  ErrInvalidDateTimeFormat,
  ErrInvalidDigest,
  ErrInvalidMediaType,
  ErrMissingArtifactType,
  ErrUnsupported,
  MediaTypeArtifactManifest,
  MediaTypeUnknownArtifact,
  MediaTypeUnknownConfig,
  Pack,
  PackManifest,
  PackManifestVersion,
  type PackManifestOptions,
  type PackOptions
} from './pack';
export {
  Referrers,
  Tags,
  type BlobStore,
  type ManifestStore,
  type ReadOnlyGraphTarget,
  type ReferenceFetcher,
  type ReferencePusher,
  type Repository,
  type TagLister
} from './registry';
export { RemoteRegistry, RemoteRepository, type RemoteRegistryOptions } from './remote';
export {
  equalDescriptorSet,
  manifestFromIndex,
  referrers
} from './repository';
export { OciStore, ReadOnlyStore } from './store';

/**
 * Package name exported for consumers that need a stable identifier.
 */
export const TOCI_PACKAGE_NAME = '@quayr/toci';
/**
 * Literal type for the toci package name.
 */
export type TociPackageName = typeof TOCI_PACKAGE_NAME;
