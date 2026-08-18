import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MemoryStore,
  computeOciDigest,
  createOciImageManifest,
  createOciReferrersTag,
  type OciDescriptor,
} from '../index';

test.describe('memory', () => {
  test.it('stores, resolves, and tags manifests in memory', async () => {
    const store = new MemoryStore();
    const manifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: 'config',
      },
      layers: [],
    });
    const bytes = Buffer.from(JSON.stringify(manifest));
    const desc: OciDescriptor = {
      mediaType: manifest.mediaType,
      digest: computeOciDigest(bytes),
      size: bytes.length,
    };

    await store.push({}, desc, bytes);
    await store.tag({}, desc, 'latest');

    const resolved = await store.resolve({}, 'latest');
    assert.equal(resolved.digest, desc.digest);
    assert.equal(resolved.mediaType, desc.mediaType);

    const fetched = await store.fetchReference({}, 'latest');
    assert.equal(fetched.desc.digest, desc.digest);

    const payload = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      fetched.stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      fetched.stream.once('end', () => resolve(Buffer.concat(chunks)));
      fetched.stream.once('error', reject);
    });
    assert.equal(payload.toString('utf8'), bytes.toString('utf8'));

    const tags: string[] = [];
    await store.Tags({}, '', async (page) => {
      tags.push(...page);
    });
    assert.deepEqual(tags, ['latest']);
  });

  test.it('tracks referrers in memory', async () => {
    const store = new MemoryStore();
    const subjectManifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: 'subject',
      },
      layers: [],
    });
    const subjectBytes = Buffer.from(JSON.stringify(subjectManifest));
    const subjectDesc: OciDescriptor = {
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
    const referrerDesc: OciDescriptor = {
      mediaType: referrerManifest.mediaType,
      digest: computeOciDigest(referrerBytes),
      size: referrerBytes.length,
    };
    await store.push({}, referrerDesc, referrerBytes);

    const referrers: OciDescriptor[] = [];
    await store.Referrers({}, subjectDesc, '', async (page) => {
      referrers.push(...page);
    });

    assert.equal(referrers.length, 1);
    assert.equal(referrers[0].digest, referrerDesc.digest);
    assert.equal(createOciReferrersTag(subjectDesc), `sha256-${subjectDesc.digest.split(':')[1]}`);
  });
});
