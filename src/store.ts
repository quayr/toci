import fs from 'node:fs';
import path from 'node:path';

import {
  createOciDescriptor,
  createOciImageIndex,
  isManifestMediaType,
  plainDescriptor,
  validateOciDigest,
  validateOciReference,
  type OciDescriptor,
  type OciImageIndex,
  type OciImageIndexInput,
  type OciImageManifest,
  type OciManifest,
} from './oci';
import type { BlobStore, ManifestStore, ReadOnlyGraphStorage, ReadOnlyGraphTarget, ReferrerLister, Repository, TagLister } from './registry';

const OCI_LAYOUT_VERSION = '1.0.0';
const OCI_LAYOUT_FILE = 'oci-layout';
const INDEX_FILE = 'index.json';
const BLOBS_DIR = 'blobs';
const REF_NAME = 'org.opencontainers.image.ref.name';

type OciStoreOptions = {
  autoSaveIndex?: boolean;
};

/**
 * Filesystem-backed OCI layout store.
 */
export class OciStore {
  readonly autoSaveIndex: boolean;
  private readonly rootDir: string;
  private index: OciImageIndex = createOciImageIndex({ manifests: [] });
  private loaded = false;

  constructor(rootDir: string, options: { autoSaveIndex?: boolean } = {}) {
    this.rootDir = rootDir;
    this.autoSaveIndex = options.autoSaveIndex !== false;
    this.ensureLayoutFile();
  }

  static async create(rootDir: string, options: { autoSaveIndex?: boolean } = {}): Promise<OciStore> {
    return new OciStore(rootDir, options);
  }

  async fetch(_ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    const filePath = this.blobPath(target.digest);
    return fs.createReadStream(filePath);
  }

  async exists(_ctx: unknown, target: OciDescriptor): Promise<boolean> {
    const filePath = this.blobPath(target.digest);
    return fs.existsSync(filePath);
  }

  async push(_ctx: unknown, expected: OciDescriptor, content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<void> {
    const bytes = await this.readContent(content);
    const actual = createOciDescriptor({ mediaType: expected.mediaType, content: bytes, annotations: expected.annotations });

    if (actual.digest !== expected.digest || actual.size !== expected.size) {
      throw new Error(`descriptor mismatch: expected ${expected.digest} (${expected.size}), got ${actual.digest} (${actual.size})`);
    }

    const filePath = this.blobPath(expected.digest);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
    await this.ensureIndexLoaded();
    if (isManifestMediaType(expected.mediaType)) {
      this.tagByDigest(expected);
    }
    this.saveIndex();
  }

  async resolve(_ctx: unknown, reference: string): Promise<OciDescriptor> {
    await this.ensureIndexLoaded();
    if (validateOciDigest(reference)) {
      const target = this.findDescriptorByDigest(reference as OciDescriptor['digest']);
      if (!target) {
        throw new Error(`descriptor not found: ${reference}`);
      }
      return plainDescriptor(target);
    }

    const target = this.findDescriptorByTag(reference);
    if (!target) {
      throw new Error(`reference not found: ${reference}`);
    }
    return target;
  }

  async tag(_ctx: unknown, desc: OciDescriptor, reference: string): Promise<void> {
    if (!validateOciReference(reference)) {
      throw new Error(`invalid reference: ${reference}`);
    }

    await this.ensureIndexLoaded();

    if (reference !== desc.digest) {
      this.index.manifests = this.index.manifests.filter((entry) => !hasRefName(entry, reference));
      const tagged = cloneDescriptorWithRef(desc, reference);
      this.index.manifests.push(tagged);
    } else if (!this.index.manifests.some((entry) => entry.digest === desc.digest)) {
      this.index.manifests.push(plainDescriptor(desc));
    }

    if (this.autoSaveIndex) {
      this.saveIndex();
    }
  }

  async untag(_ctx: unknown, reference: string): Promise<void> {
    if (reference === '') {
      throw new Error('missing reference');
    }
    if (validateOciDigest(reference)) {
      throw new Error(`reference ${reference} is a digest and not a tag`);
    }

    await this.ensureIndexLoaded();
    this.index.manifests = this.index.manifests.filter((entry) => entry.annotations?.[REF_NAME] !== reference);

    if (this.autoSaveIndex) {
      this.saveIndex();
    }
  }

  async predecessors(_ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    await this.ensureIndexLoaded();
    const results: OciDescriptor[] = [];

    for (const entry of this.index.manifests) {
      const subject = await this.subjectForDescriptor(entry);
      if (subject && subject.digest === node.digest) {
        results.push(normalizeForGraph(entry));
      }
    }

    return results;
  }

  async tags(_ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    await this.ensureIndexLoaded();
    const tags = this.index.manifests
      .map((entry) => entry.annotations?.[REF_NAME])
      .filter((tag): tag is string => typeof tag === 'string' && tag !== '')
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

  getIndex(): OciImageIndex {
    return this.index;
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

  async Delete(_ctx: unknown, target: OciDescriptor): Promise<void> {
    const filePath = this.blobPath(target.digest);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    await this.ensureIndexLoaded();
    this.index.manifests = this.index.manifests.filter((entry) => entry.digest !== target.digest);
    if (this.autoSaveIndex) {
      this.saveIndex();
    }
  }

  Referrers(ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    return this.tagsBasedReferrers(ctx, desc, artifactType, fn);
  }

  Blobs(): BlobStore {
    return this;
  }

  Manifests(): ManifestStore {
    return this;
  }

  private blobPath(digest: string): string {
    const parsed = digest.split(':', 2);
    if (parsed.length !== 2 || parsed[0] === '' || parsed[1] === '') {
      throw new Error(`invalid digest: ${digest}`);
    }
    return path.join(this.rootDir, BLOBS_DIR, parsed[0], parsed[1]);
  }

  private ensureLayoutFile(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const layoutPath = path.join(this.rootDir, OCI_LAYOUT_FILE);
    if (!fs.existsSync(layoutPath)) {
      fs.writeFileSync(layoutPath, JSON.stringify({ imageLayoutVersion: OCI_LAYOUT_VERSION }, null, 2));
    }
    const indexPath = path.join(this.rootDir, INDEX_FILE);
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }, null, 2));
    }
  }

  private async ensureIndexLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const indexPath = path.join(this.rootDir, INDEX_FILE);
    const raw = fs.readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as OciImageIndexInput;
    this.index = createOciImageIndex({ manifests: Array.isArray(parsed.manifests) ? parsed.manifests : [], annotations: parsed.annotations, subject: parsed.subject, artifactType: parsed.artifactType });
    this.loaded = true;
  }

  private saveIndex(): void {
    const indexPath = path.join(this.rootDir, INDEX_FILE);
    fs.writeFileSync(indexPath, JSON.stringify(this.index, null, 2));
  }

  private findDescriptorByDigest(digest: OciDescriptor['digest']): OciDescriptor | undefined {
    const tagged = this.index.manifests.find((entry) => entry.digest === digest);
    if (tagged) {
      return tagged;
    }
    const filePath = this.blobPath(digest);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const stat = fs.statSync(filePath);
    return {
      mediaType: 'application/octet-stream',
      digest,
      size: stat.size,
    };
  }

  private findDescriptorByTag(reference: string): OciDescriptor | undefined {
    return this.index.manifests.find((entry) => entry.annotations?.[REF_NAME] === reference);
  }

  private tagByDigest(desc: OciDescriptor): void {
    if (!this.index.manifests.some((entry) => entry.digest === desc.digest)) {
      this.index.manifests.push(plainDescriptor(desc));
    }
  }

  private async subjectForDescriptor(desc: OciDescriptor): Promise<OciDescriptor | undefined> {
    if (!isManifestMediaType(desc.mediaType)) {
      return undefined;
    }
    const raw = fs.readFileSync(this.blobPath(desc.digest), 'utf8');
    const payload = JSON.parse(raw) as OciImageManifest | OciManifest;
    return payload.subject;
  }

  private async readContent(content: Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream | Buffer): Promise<Uint8Array> {
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

  private async tagsBasedReferrers(_ctx: unknown, desc: OciDescriptor, artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    await this.ensureIndexLoaded();
    const referrers: OciDescriptor[] = [];
    for (const entry of this.index.manifests) {
      const subject = await this.subjectForDescriptor(entry);
      if (subject && subject.digest === desc.digest) {
        if (artifactType === '' || entry.artifactType === artifactType) {
          referrers.push(plainDescriptor(entry));
        }
      }
    }
    await fn(referrers);
  }
}

export class ReadOnlyStore {
  private readonly store: OciStore;

  constructor(rootDir: string) {
    this.store = new OciStore(rootDir, { autoSaveIndex: false });
  }

  fetch(ctx: unknown, target: OciDescriptor) {
    return this.store.fetch(ctx, target);
  }

  exists(ctx: unknown, target: OciDescriptor) {
    return this.store.exists(ctx, target);
  }

  resolve(ctx: unknown, reference: string) {
    return this.store.resolve(ctx, reference);
  }

  predecessors(ctx: unknown, node: OciDescriptor) {
    return this.store.predecessors(ctx, node);
  }

  tags(ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void) {
    return this.store.tags(ctx, last, fn);
  }

  async Fetch(ctx: unknown, target: OciDescriptor): Promise<NodeJS.ReadableStream> {
    return this.store.Fetch(ctx, target);
  }

  async Exists(ctx: unknown, target: OciDescriptor): Promise<boolean> {
    return this.store.Exists(ctx, target);
  }

  async Resolve(ctx: unknown, reference: string): Promise<OciDescriptor> {
    return this.store.Resolve(ctx, reference);
  }

  async Predecessors(ctx: unknown, node: OciDescriptor): Promise<OciDescriptor[]> {
    return this.store.Predecessors(ctx, node);
  }

  async Tags(ctx: unknown, last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    return this.store.Tags(ctx, last, fn);
  }

  async FetchReference(ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    return this.store.FetchReference(ctx, reference);
  }
}

declare const _repositoryCheck: Repository;
declare const _readOnlyCheck: ReadOnlyGraphTarget;
declare const _tagListerCheck: TagLister;
declare const _graphStorageCheck: ReadOnlyGraphStorage;
declare const _referrerListerCheck: ReferrerLister;

function hasRefName(desc: OciDescriptor, reference: string): boolean {
  return desc.annotations?.[REF_NAME] === reference;
}

function cloneDescriptorWithRef(desc: OciDescriptor, reference: string): OciDescriptor {
  return {
    ...plainDescriptor(desc),
    annotations: {
      ...(desc.annotations ?? {}),
      [REF_NAME]: reference,
    },
  };
}

function normalizeForGraph(desc: OciDescriptor): OciDescriptor {
  return {
    ...plainDescriptor(desc),
    ...(desc.artifactType ? { artifactType: desc.artifactType } : {}),
    ...(desc.platform ? { platform: desc.platform } : {}),
  };
}
