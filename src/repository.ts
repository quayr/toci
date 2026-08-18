import { isManifestMediaType, plainDescriptor, type OciDescriptor, type OciImageIndex } from './oci';

/** @internal */
export interface ReadOnlyGraphStorage {
  predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> | OciDescriptor[];
  fetchAll(ctx: unknown, node: OciDescriptor): Promise<Uint8Array> | Uint8Array;
}

/** @internal */
export interface ReferrerLister {
  referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => unknown): Promise<void> | void;
}

/**
 * Returns every referrer for a descriptor, normalizing entries from the backing store.
 */
export async function referrers(
  ctx: unknown,
  store: {
    predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> | OciDescriptor[];
  } | {
    referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => unknown): Promise<void> | void;
  },
  desc: OciDescriptor,
  artifactType = '',
): Promise<OciDescriptor[]> {
  if (!isManifestMediaType(desc.mediaType)) {
    throw new Error(`the descriptor ${JSON.stringify(desc)} is not a manifest`);
  }

  if (isReferrerLister(store)) {
    const results: OciDescriptor[] = [];
    await store.referrers(ctx, desc, artifactType, async (page) => {
      results.push(...page);
    });
    return results;
  }

  const results: OciDescriptor[] = [];
  const predecessors = await store.predecessors(ctx, desc);
  for (const node of predecessors) {
    if (artifactType !== '' && node.artifactType !== artifactType) {
      continue;
    }
    results.push(normalizeReferrer(node));
  }
  return results;
}

/**
 * Compares two descriptor sets while ignoring ordering.
 */
export function equalDescriptorSet(actual: OciDescriptor[], expected: OciDescriptor[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const sortKey = (desc: OciDescriptor) => `${desc.digest}|${desc.mediaType}|${desc.size}`;
  const a = [...actual].map(sortKey).sort();
  const b = [...expected].map(sortKey).sort();
  return a.every((value, index) => value === b[index]);
}

function isReferrerLister(value: unknown): value is {
  referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => unknown): Promise<void> | void;
} {
  return typeof (value as { referrers?: unknown }).referrers === 'function';
}

function normalizeReferrer(desc: OciDescriptor): OciDescriptor {
  return plainDescriptor(desc);
}

/**
 * Extracts the manifest descriptors from an OCI image index.
 */
export function manifestFromIndex(index: OciImageIndex): OciDescriptor[] {
  return index.manifests;
}
