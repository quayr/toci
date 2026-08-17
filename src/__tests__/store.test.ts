import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OciStore,
  computeOciDigest,
  createOciImageManifest,
  createOciReferrersTag,
} from '../index';

test.describe('store', () => {
  let tempDir: string;

  test.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toci-store-'));
  });

  test.afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test.it('stores and resolves tagged manifests', async () => {
    const store = new OciStore(tempDir);
    const manifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: 'config',
      },
      layers: [],
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const desc = {
      mediaType: manifest.mediaType,
      digest: computeOciDigest(manifestBytes),
      size: manifestBytes.length,
    };

    await store.push({}, desc, manifestBytes);
    await store.tag({}, desc, 'latest');

    const resolved = await store.resolve({}, 'latest');
    assert.equal(resolved.digest, desc.digest);
    assert.equal(resolved.mediaType, desc.mediaType);

    const digestResolved = await store.resolve({}, desc.digest);
    assert.equal(digestResolved.digest, desc.digest);
    assert.equal(digestResolved.size, desc.size);

    const tags: string[] = [];
    await store.tags({}, '', (chunk) => {
      tags.push(...chunk);
    });
    assert.deepEqual(tags, ['latest']);
  });

  test.it('computes referrers and digest tags', async () => {
    const store = new OciStore(tempDir);
    const subjectManifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: 'config',
      },
      layers: [],
    });
    const subjectBytes = Buffer.from(JSON.stringify(subjectManifest));
    const subjectDesc = {
      mediaType: subjectManifest.mediaType,
      digest: computeOciDigest(subjectBytes),
      size: subjectBytes.length,
    };
    await store.push({}, subjectDesc, subjectBytes);

    const referrerManifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: 'signature',
      },
      layers: [],
      subject: subjectDesc,
    });
    const referrerBytes = Buffer.from(JSON.stringify(referrerManifest));
    const referrerDesc = {
      mediaType: referrerManifest.mediaType,
      digest: computeOciDigest(referrerBytes),
      size: referrerBytes.length,
    };
    await store.push({}, referrerDesc, referrerBytes);

    const predecessors = await store.predecessors({}, subjectDesc);
    assert.equal(predecessors.length, 1);
    assert.equal(predecessors[0].digest, referrerDesc.digest);
    assert.equal(createOciReferrersTag(subjectDesc), `${subjectDesc.digest.split(':')[0]}-${subjectDesc.digest.split(':')[1]}`);
  });
});
