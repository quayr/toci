import { type OciDescriptor, type OciImageIndex, type OciImageManifest } from './oci';

/**
 * Returns the manifest entries embedded in an OCI manifest or index payload.
 */
export function manifests(desc: OciDescriptor, payload: OciImageManifest | OciImageIndex | null | undefined): OciDescriptor[] {
  if (!payload) {
    return [];
  }
  if ('manifests' in payload) {
    return payload.manifests;
  }
  return [];
}

/**
 * Returns the referrer subject descriptor from an OCI manifest or index payload.
 */
export function subject(desc: OciDescriptor, payload: OciImageManifest | OciImageIndex | null | undefined): OciDescriptor | undefined {
  if (!payload) {
    return undefined;
  }
  return 'subject' in payload ? payload.subject : undefined;
}
