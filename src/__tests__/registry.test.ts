import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OciStore,
  ReadOnlyStore,
  Referrers,
  Tags,
  computeOciDigest,
  createOciImageManifest,
  type ReadOnlyGraphTarget,
  type Repository,
} from '../index';

test.describe('registry', () => {
  let tempDir: string;

  test.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toci-registry-'));
  });

  test.afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test.it('store satisfies the registry interface slice', async () => {
    const repository: Repository = new OciStore(tempDir);
    const readOnly: ReadOnlyGraphTarget = new ReadOnlyStore(tempDir);

    const manifest = createOciImageManifest({
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', content: 'config' },
      layers: [],
    });
    const bytes = Buffer.from(JSON.stringify(manifest));
    const desc = {
      mediaType: manifest.mediaType,
      digest: computeOciDigest(bytes),
      size: bytes.length,
    };

    await repository.Push({}, desc, bytes);
    await repository.Tag({}, desc, 'latest');

    const repoTags = await Tags({}, repository);
    const readOnlyTags = await Tags({}, readOnly);
    assert.deepEqual(repoTags, ['latest']);
    assert.deepEqual(readOnlyTags, ['latest']);

    const referrers = await Referrers({}, repository, desc);
    assert.deepEqual(referrers, []);

    const fetched = await repository.FetchReference({}, 'latest');
    assert.equal(fetched.desc.digest, desc.digest);
    // Drain the stream so no lazy fs I/O is left pending after the test ends
    await new Promise<void>((resolve, reject) => {
      fetched.stream.on('data', () => undefined);
      fetched.stream.once('end', () => resolve());
      fetched.stream.once('error', reject);
    });
  });
});
