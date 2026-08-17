import { Readable } from 'node:stream';

import {
  createOciDescriptor,
  createOciImageIndex,
  isManifestMediaType,
  plainDescriptor,
  validateOciDigest,
  validateOciReference,
  type OciDescriptor,
  type OciImageIndex,
  type OciImageManifest,
  type OciManifest,
} from './oci';
import type { BlobStore, ManifestStore } from './registry';

const REF_NAME = 'org.opencontainers.image.ref.name';

/**
 * Options for configuring the in-memory OCI store.
 */
export interface MemoryStoreOptions {
  autoSaveIndex?: boolean;
}

/**
 * In-memory OCI blob, manifest, tag, and referrer store.
 */
export class MemoryStore {
  readonly autoSaveIndex: boolean;
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly manifests = new Map<string, OciDescriptor>();
  private readonly tagsByReference = new Map<string, string>();
  private readonly subjectsByDigest = new Map<string, OciDescriptor[]>();
  private index: OciImageIndex = createOciImageIndex({ manifests: [] });

  constructor(options: MemoryStoreOptions = {}) {
    this.autoSaveIndex = options.autoSaveIndex !== false;
  }

  async fetch(_ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    const bytes = this.blobs.get(target.digest);
    if (!bytes) {
      throw new Error(`descriptor not found: ${target.digest}`);
    }
    return Readable.from([Buffer.from(bytes)]);
  }

  async exists(_ctx: unknown, target: OciDescriptor): Promise<boolean> {
    return this.blobs.has(target.digest) || this.manifests.has(target.digest);
  }

  async push(_ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    const bytes = await toBytes(content);
    const actual = createOciDescriptor({ mediaType: expected.mediaType, content: bytes, annotations: expected.annotations });

    if (actual.digest !== expected.digest || actual.size !== expected.size) {
      throw new Error(`descriptor mismatch: expected ${expected.digest} (${expected.size}), got ${actual.digest} (${actual.size})`);
    }

    this.blobs.set(expected.digest, bytes);
    this.manifests.set(expected.digest, plainDescriptor({ ...expected, size: bytes.length }));

    if (isManifestMediaType(expected.mediaType)) {
      this.recordManifest(expected, bytes);
    }

    this.saveIndexIfNeeded();
  }

  async resolve(_ctx: unknown, reference: string): Promise<OciDescriptor> {
    if (validateOciDigest(reference)) {
      const descriptor = this.manifests.get(reference);
      if (!descriptor) {
        throw new Error(`descriptor not found: ${reference}`);
      }
      return plainDescriptor(descriptor);
    }

    const digest = this.tagsByReference.get(reference);
    if (!digest) {
      throw new Error(`reference not found: ${reference}`);
    }

    const descriptor = this.manifests.get(digest);
    if (!descriptor) {
      throw new Error(`descriptor not found: ${digest}`);
    }

    return this.taggedDescriptor(descriptor, reference);
  }

  async tag(_ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> {
    if (!validateOciReference(reference)) {
      throw new Error(`invalid reference: ${reference}`);
    }

    this.tagsByReference.set(reference, desc.digest);

    const stored = this.manifests.get(desc.digest) ?? plainDescriptor(desc);
    this.manifests.set(desc.digest, this.taggedDescriptor(stored, reference));
    this.index.manifests = Array.from(this.manifests.values()).map((entry) => plainDescriptor(entry));

    this.saveIndexIfNeeded();
  }

  async untag(_ctx: unknown, reference: string): Promise<void> {
    this.tagsByReference.delete(reference);

    const descriptor = Array.from(this.manifests.values()).find((entry) => entry.annotations?.[REF_NAME] === reference);
    if (descriptor) {
      const next = plainDescriptor(descriptor);
      if (descriptor.artifactType) {
        next.artifactType = descriptor.artifactType;
      }
      if (descriptor.platform) {
        next.platform = descriptor.platform;
      }
      this.manifests.set(descriptor.digest, next);
      this.index.manifests = Array.from(this.manifests.values()).map((entry) => plainDescriptor(entry));
      this.saveIndexIfNeeded();
    }
  }

  async predecessors(_ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    return (this.subjectsByDigest.get(node.digest) ?? []).map((entry) => plainDescriptor(entry));
  }

  async tags(_ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    const tags = Array.from(this.tagsByReference.keys())
      .filter((tag) => last === '' || tag > last)
      .sort();

    await fn(tags);
  }

  async fetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    const desc = await this.resolve(ctx, reference);
    return { desc, stream: await this.fetch(ctx, desc) };
  }

  async pushReference(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer, reference: string): Promise<void> {
    await this.push(ctx, expected, content);
    await this.tag(ctx, expected, reference);
  }

  Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    const referrers = (this.subjectsByDigest.get(desc.digest) ?? [])
      .filter((entry) => artifactType === '' || entry.artifactType === artifactType)
      .map((entry) => plainDescriptor(entry));
    return Promise.resolve(fn(referrers));
  }

  Blobs(): BlobStore {
    return this;
  }

  Manifests(): ManifestStore {
    return this;
  }

  async Delete(_ctx: unknown, target: OciDescriptor): Promise<void> {
    this.blobs.delete(target.digest);
    this.manifests.delete(target.digest);
    this.subjectsByDigest.delete(target.digest);
    for (const [reference, digest] of this.tagsByReference.entries()) {
      if (digest === target.digest) {
        this.tagsByReference.delete(reference);
      }
    }
    this.index.manifests = Array.from(this.manifests.values()).map((entry) => plainDescriptor(entry));
    this.saveIndexIfNeeded();
  }

  async Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    return this.fetch(ctx, target);
  }

  async Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> {
    return this.exists(ctx, target);
  }

  async Push(ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    return this.push(ctx, expected, content);
  }

  async Resolve(ctx: unknown, reference: string): Promise<OciDescriptor> {
    return this.resolve(ctx, reference);
  }

  async Tag(ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> {
    return this.tag(ctx, desc, reference);
  }

  async Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    return this.predecessors(ctx, node);
  }

  async Tags(ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    return this.tags(ctx, last, fn);
  }

  async FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    return this.fetchReference(ctx, reference);
  }

  async PushReference(ctx: unknown, expected: OciDescriptor, content: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer, reference: string): Promise<void> {
    return this.pushReference(ctx, expected, content, reference);
  }

  async DeleteReference(ctx: unknown, target: OciDescriptor): Promise<void> {
    return this.Delete(ctx, target);
  }

  private recordManifest(expected: OciDescriptor, bytes: Uint8Array): void {
    try {
      const payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as OciImageManifest | OciManifest;
      if (payload.subject) {
        const current = this.subjectsByDigest.get(payload.subject.digest) ?? [];
        if (!current.some((entry) => entry.digest === expected.digest)) {
          current.push(this.taggedDescriptor(expected, this.findTagForDigest(expected.digest)));
          this.subjectsByDigest.set(payload.subject.digest, current);
        }
      }

      const stored = this.manifests.get(expected.digest) ?? plainDescriptor(expected);
      this.manifests.set(expected.digest, this.taggedDescriptor(stored, this.findTagForDigest(expected.digest)));
      this.index = createOciImageIndex({ manifests: Array.from(this.manifests.values()).map((entry) => plainDescriptor(entry)) });
    } catch {
      this.index = createOciImageIndex({ manifests: Array.from(this.manifests.values()).map((entry) => plainDescriptor(entry)) });
    }
  }

  private taggedDescriptor(desc: OciDescriptor, reference: string | undefined): OciDescriptor {
    if (!reference) {
      return plainDescriptor(desc);
    }

    return {
      ...plainDescriptor(desc),
      ...(desc.artifactType ? { artifactType: desc.artifactType } : {}),
      ...(desc.platform ? { platform: desc.platform } : {}),
      annotations: {
        ...(desc.annotations ?? {}),
        [REF_NAME]: reference,
      },
    };
  }

  private findTagForDigest(digest: string): string | undefined {
    for (const [reference, storedDigest] of this.tagsByReference.entries()) {
      if (storedDigest === digest) {
        return reference;
      }
    }
    return undefined;
  }

  private saveIndexIfNeeded(): void {
    if (!this.autoSaveIndex) {
      return;
    }
    this.index = createOciImageIndex({ manifests: Array.from(this.manifests.values()).map((entry) => plainDescriptor(entry)) });
  }
}

async function toBytes(content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (typeof (content as NodeJS.ReadableStream).read === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array | Buffer>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of content as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
