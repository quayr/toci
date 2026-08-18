import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeOciDigest,
  createOciDescriptor,
  ErrInvalidDateTimeFormat,
  ErrInvalidDigest,
  ErrInvalidMediaType,
  ErrMissingArtifactType,
  ErrUnsupported,
  MediaTypeUnknownArtifact,
  OciStore,
  Pack,
  PackManifest,
  PackManifestVersion,
  type OciDescriptor
} from '../index';

function manifestBytes(store: OciStore, descDigest: string): string {
  const manifestPath = path.join((store as unknown as { rootDir?: string }).rootDir ?? '', 'blobs', 'sha256', descDigest.split(':')[1]);
  return fs.readFileSync(manifestPath, 'utf8');
}

test.describe('pack', () => {
  let tempDir: string;

  test.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toci-pack-'));
  });

  test.afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test.it('packs artifact manifests', async () => {
    const store = new OciStore(tempDir);
    const blob = createOciDescriptor({ mediaType: 'test', content: 'hello world' });
    const desc = await Pack({}, store, 'application/vnd.test', [blob], {});
    assert.equal(desc.artifactType, 'application/vnd.test');
    assert.equal(desc.mediaType, 'application/vnd.oci.artifact.manifest.v1+json');
    assert.match(manifestBytes(store, desc.digest), /"artifactType":"application\/vnd\.test"/);
  });

  test.it('packs image manifest rc2', async () => {
    const store = new OciStore(tempDir);
    const layer = createOciDescriptor({ mediaType: 'test', content: 'layer' });
    const desc = await Pack({}, store, 'application/vnd.test', [layer], { PackImageManifest: true });
    assert.equal(desc.mediaType, 'application/vnd.oci.image.manifest.v1+json');
    assert.equal(desc.artifactType, 'application/vnd.test');
  });

  test.it('packs manifest v1.0 defaults', async () => {
    const store = new OciStore(tempDir);
    const desc = await PackManifest({}, store, PackManifestVersion.PackManifestVersion1_0, 'application/vnd.test', {});
    assert.equal(desc.artifactType, 'application/vnd.test');
    assert.equal(desc.mediaType, 'application/vnd.oci.image.manifest.v1+json');
  });

  test.it('pack manifest v1.1 requires artifact type or config', async () => {
    const store = new OciStore(tempDir);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_1, '', {}), ErrMissingArtifactType);
  });

  test.it('pack manifest v1.1 accepts config descriptor without artifact type', async () => {
    const store = new OciStore(tempDir);
    const config = createOciDescriptor({ mediaType: 'application/vnd.test.config', content: '{}' });
    const desc = await PackManifest({}, store, PackManifestVersion.PackManifestVersion1_1, '', { ConfigDescriptor: config });
    assert.equal(desc.artifactType, 'application/vnd.test.config');
  });

  test.it('pack manifest rejects invalid dates', async () => {
    const store = new OciStore(tempDir);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_1, 'application/vnd.test', { ManifestAnnotations: { 'org.opencontainers.image.created': '2000/01/01 00:00:00' } }), ErrInvalidDateTimeFormat);
  });

  test.it('pack manifest rejects invalid media types and digests', async () => {
    const store = new OciStore(tempDir);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_1, 'invalid media type', {}), ErrInvalidMediaType);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_1, 'application/vnd.test', {
      ConfigDescriptor: {
        mediaType: 'invalid media type',
        digest: (`sha256:${'a'.repeat(64)}` as OciDescriptor['digest']),
        size: 1,
      },
    }), ErrInvalidMediaType);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_1, 'application/vnd.test', {
      ConfigDescriptor: {
        mediaType: 'application/vnd.test.config',
        digest: ('invalid' as unknown as OciDescriptor['digest']),
        size: 1,
      },
    }), ErrInvalidDigest);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_0, 'application/vnd.test', {
      ConfigDescriptor: {
        mediaType: 'application/vnd.test.config',
        digest: ('' as unknown as OciDescriptor['digest']),
        size: 0,
      },
    }), ErrInvalidDigest);
    await assert.rejects(() => Pack({}, store, 'application/vnd.test', [], {
      PackImageManifest: true,
      ConfigDescriptor: {
        mediaType: 'application/vnd.test.config',
        digest: ('' as unknown as OciDescriptor['digest']),
        size: 0,
      },
    }), ErrInvalidDigest);
  });

  test.it('pack manifest v1.0 rejects subjects', async () => {
    const store = new OciStore(tempDir);
    await assert.rejects(() => PackManifest({}, store, PackManifestVersion.PackManifestVersion1_0, 'application/vnd.test', {
      Subject: {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: computeOciDigest('{}'),
        size: 2,
      },
    }), ErrUnsupported);
  });

  test.it('pack manifest rejects unsupported version', async () => {
    const store = new OciStore(tempDir);
    await assert.rejects(() => PackManifest({}, store, -1 as PackManifestVersion, '', {}), ErrUnsupported);
  });

  test.it('pack artifact default type and empty config', async () => {
    const store = new OciStore(tempDir);
    const desc = await Pack({}, store, '', [], {});
    assert.equal(desc.artifactType, MediaTypeUnknownArtifact);
    assert.equal(desc.mediaType, 'application/vnd.oci.artifact.manifest.v1+json');
  });
});
