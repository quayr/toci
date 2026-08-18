import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  WithPolicyEnforcement,
  createAllowAllPolicy,
  createDenyAllPolicy,
  type OciDescriptor,
  type Repository,
} from '../index';

class StubRepository implements Repository {
  fetchCalls = 0;
  pushCalls = 0;
  pushReferenceCalls = 0;
  existsCalls = 0;
  deleteCalls = 0;
  resolveCalls = 0;
  tagCalls = 0;
  fetchReferenceCalls = 0;
  predecessorsCalls = 0;
  tagsCalls = 0;
  referrersCalls = 0;

  async Fetch(): Promise<NodeJS.ReadableStream> {
    this.fetchCalls += 1;
    return Readable.from(['content']);
  }

  async Push(): Promise<void> {
    this.pushCalls += 1;
  }

  async PushReference(): Promise<void> {
    this.pushReferenceCalls += 1;
  }

  async Exists(): Promise<boolean> {
    this.existsCalls += 1;
    return true;
  }

  async Delete(): Promise<void> {
    this.deleteCalls += 1;
  }

  async Resolve(_ctx: unknown, reference: string): Promise<OciDescriptor> {
    this.resolveCalls += 1;
    return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: reference as OciDescriptor['digest'], size: 1 };
  }

  async Tag(): Promise<void> {
    this.tagCalls += 1;
  }

  async FetchReference(_ctx: unknown, reference: string): Promise<{ desc: OciDescriptor; stream: NodeJS.ReadableStream }> {
    this.fetchReferenceCalls += 1;
    return {
      desc: { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: reference as OciDescriptor['digest'], size: 1 },
      stream: Readable.from(['content']),
    };
  }

  async Referrers(_ctx: unknown, desc: OciDescriptor, _artifactType: string, fn: (referrers: OciDescriptor[]) => Promise<void> | void): Promise<void> {
    this.referrersCalls += 1;
    await fn([desc]);
  }

  async Tags(_ctx: unknown, _last: string, fn: (tags: string[]) => Promise<void> | void): Promise<void> {
    this.tagsCalls += 1;
    await fn(['latest']);
  }

  async Predecessors(): Promise<OciDescriptor[]> {
    this.predecessorsCalls += 1;
    return [];
  }

  Blobs() {
    return this;
  }

  Manifests() {
    return this;
  }
}

test.describe('middleware', () => {
  test.it('deny-all policy blocks content operations', async () => {
    const wrapped = WithPolicyEnforcement(createDenyAllPolicy())(new StubRepository());
    const desc: OciDescriptor = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${'a'.repeat(64)}` as OciDescriptor['digest'],
      size: 1,
    };

    const expectDenied = (action: () => unknown) => assert.rejects(Promise.resolve().then(action), /access denied/);

    await expectDenied(() => wrapped.Fetch({}, desc));
    await expectDenied(() => wrapped.Push({}, desc, Readable.from(['x'])));
    await expectDenied(() => wrapped.Exists({}, desc));
    await expectDenied(() => wrapped.Delete({}, desc));
    await expectDenied(() => wrapped.Resolve({}, 'latest'));
    await expectDenied(() => wrapped.Tag({}, desc, 'latest'));
    await expectDenied(() => wrapped.FetchReference({}, 'latest'));
    await expectDenied(() => wrapped.Predecessors({}, desc));
    await expectDenied(() => wrapped.Blobs().Fetch({}, desc));
    await expectDenied(() => wrapped.Manifests().Resolve({}, 'latest'));
  });

  test.it('deny-all policy still allows tags and referrers carve-outs', async () => {
    const base = new StubRepository();
    const wrapped = WithPolicyEnforcement(createDenyAllPolicy())(base);
    const desc: OciDescriptor = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${'b'.repeat(64)}` as OciDescriptor['digest'],
      size: 1,
    };

    const tags: string[] = [];
    await wrapped.Tags({}, '', async (page) => {
      tags.push(...page);
    });
    assert.deepEqual(tags, ['latest']);
    assert.equal(base.tagsCalls, 1);

    const referrers: OciDescriptor[] = [];
    await wrapped.Referrers({}, desc, '', async (page) => {
      referrers.push(...page);
    });
    assert.deepEqual(referrers, [desc]);
    assert.equal(base.referrersCalls, 1);
  });

  test.it('allow-all policy forwards to the base repository', async () => {
    const base = new StubRepository();
    const wrapped = WithPolicyEnforcement(createAllowAllPolicy())(base);
    const desc: OciDescriptor = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${'c'.repeat(64)}` as OciDescriptor['digest'],
      size: 1,
    };

    await wrapped.Fetch({}, desc);
    await wrapped.Push({}, desc, Readable.from(['x']));
    await wrapped.Exists({}, desc);
    await wrapped.Delete({}, desc);
    await wrapped.Resolve({}, 'latest');
    await wrapped.Tag({}, desc, 'latest');
    await wrapped.FetchReference({}, 'latest');
    await wrapped.Predecessors({}, desc);

    assert.equal(base.fetchCalls, 1);
    assert.equal(base.pushCalls, 1);
    assert.equal(base.existsCalls, 1);
    assert.equal(base.deleteCalls, 1);
    assert.equal(base.resolveCalls, 1);
    assert.equal(base.tagCalls, 1);
    assert.equal(base.fetchReferenceCalls, 1);
    assert.equal(base.predecessorsCalls, 1);
  });
});
