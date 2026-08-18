import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOCI_PACKAGE_NAME,
  computeOciDigest,
  createOciImageManifest,
  createOciReferrersTag,
  equalDescriptorSet,
  isManifestMediaType,
  manifests,
  parseOciDigest,
  referrers,
  subject,
  toOciBytes,
  validateOciDigest,
  type OciDescriptor,
} from '../index';

test.describe('index', () => {
  test.it('exports the package name', () => {
    assert.equal(TOCI_PACKAGE_NAME, '@quayr/toci');
  });

  test.it('computes OCI digests and parses them', () => {
    const digest = computeOciDigest('hello');
    assert.equal(digest, 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(validateOciDigest(digest), true);
    assert.deepEqual(parseOciDigest(digest), {
      algorithm: 'sha256',
      encoded: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
  });

  test.it('builds manifests and referrers tags', () => {
    const manifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: { architecture: 'amd64' },
      },
      layers: [],
    });
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.mediaType, 'application/vnd.oci.image.manifest.v1+json');
    assert.equal(isManifestMediaType(manifest.mediaType), true);
    assert.equal(createOciReferrersTag({ digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  test.it('parses manifest utilities', () => {
    const manifest = createOciImageManifest({
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        content: 'config',
      },
      layers: [],
      subject: {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        size: 1,
      },
    });
    assert.equal(subject(manifest.subject!, manifest), manifest.subject);
    assert.deepEqual(manifests(manifest.subject!, manifest), []);
    assert.deepEqual(Array.from(toOciBytes('abc')), [97, 98, 99]);
  });

  test.it('compares descriptor sets and resolves referrers locally', async () => {
    const target: OciDescriptor = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as OciDescriptor['digest'],
      size: 10,
    };
    const referrer: OciDescriptor = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as OciDescriptor['digest'],
      size: 20,
      artifactType: 'example/signature',
    };
    const store: {
      predecessors(): Promise<OciDescriptor[]>;
      fetchAll(): Promise<Uint8Array>;
    } = {
      async predecessors() {
        return [referrer];
      },
      async fetchAll() {
        return new Uint8Array();
      },
    };
    const results = await referrers({}, store, target);
    assert.equal(equalDescriptorSet(results, [referrer]), true);
  });
});
