import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { OciDescriptor } from '../index';
import { computeOciDigest, createOciDescriptor, createOciImageIndex, createOciImageManifest, createOciReferrersTag, RemoteRegistry, RemoteRepository } from '../index';
async function withServer(handler: http.RequestListener, run: (host: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to start test server');
  }
  try {
    await run(`127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test.describe('remote', () => {
  test.it('remote registry ping and catalog pagination', async () => {
    const requests: string[] = [];
    await withServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/v2/') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.url === '/v2/_catalog?n=2') {
        res.setHeader('Link', '</v2/_catalog?n=2&last=repo2>; rel="next"');
        res.end(JSON.stringify({ repositories: ['repo1', 'repo2'] }));
        return;
      }
      if (req.url === '/v2/_catalog?n=2&last=repo2') {
        res.end(JSON.stringify({ repositories: ['repo3'] }));
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, { plainHTTP: true, repositoryListPageSize: 2 });
      await registry.Ping({});
      const pages: string[][] = [];
      await registry.Repositories({}, '', async (repos) => {
        pages.push(repos);
      });
      assert.deepEqual(pages, [['repo1', 'repo2'], ['repo3']]);
      assert.deepEqual(requests, ['GET /v2/', 'GET /v2/_catalog?n=2', 'GET /v2/_catalog?n=2&last=repo2']);
    });
  });

  test.it('remote repository fetches manifests and blobs from their respective endpoints', async () => {
    const manifest = Buffer.from('{"artifactType":"test"}');
    const blob = Buffer.from('{"name":"release-please"}');
    const manifestDescriptor = createOciDescriptor({
      mediaType: 'application/vnd.oci.artifact.manifest.v1+json',
      content: manifest,
    });
    const blobDescriptor = createOciDescriptor({
      mediaType: 'application/vnd.quayr.blueprint.bundle.v1+json',
      content: blob,
    });

    await withServer((req, res) => {
      if (req.url === `/v2/blueprints/manifests/${manifestDescriptor.digest}`) {
        res.writeHead(200, { 'Content-Type': manifestDescriptor.mediaType });
        res.end(manifest);
        return;
      }
      if (req.url === `/v2/blueprints/blobs/${blobDescriptor.digest}`) {
        res.writeHead(200, { 'Content-Type': blobDescriptor.mediaType });
        res.end(blob);
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (host) => {
      const repository = new RemoteRegistry(host, { plainHTTP: true }).Repository('blueprints');
      const manifestStream = await repository.Fetch({}, manifestDescriptor);
      const blobStream = await repository.Fetch({}, blobDescriptor);

      assert.equal((await streamBytes(manifestStream)).toString(), manifest.toString());
      assert.equal((await streamBytes(blobStream)).toString(), blob.toString());
    });
  });

  test.it('remote registry applies custom headers and retries transient failures', async () => {
    const requests: Array<{ authorization?: string; userAgent?: string }> = [];
    let attempts = 0;

    await withServer((req, res) => {
      attempts += 1;
      requests.push({
        authorization: req.headers.authorization,
        userAgent: req.headers['user-agent'],
      });

      if (attempts === 1) {
        res.writeHead(429, { 'Retry-After': '0' });
        res.end();
        return;
      }

      if (req.url === '/v2/') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        headers: {
          Authorization: 'Bearer test-token',
          'User-Agent': 'quayr-test',
        },
        retryAttempts: 1,
      });

      await registry.Ping({});

      assert.equal(attempts, 2);
      assert.deepEqual(requests, [
        { authorization: 'Bearer test-token', userAgent: 'quayr-test' },
        { authorization: 'Bearer test-token', userAgent: 'quayr-test' },
      ]);
    });
  });

  test.it('remote registry applies auth headers', async () => {
    const seen: Array<{ authorization?: string }> = [];

    await withServer((req, res) => {
      seen.push({ authorization: req.headers.authorization });
      if (req.url === '/v2/') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (host) => {
      const basicRegistry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'secret',
        },
      });

      await basicRegistry.Ping({});

      const bearerRegistry = new RemoteRegistry(host, {
        plainHTTP: true,
        bearerToken: 'token-123',
      });

      await bearerRegistry.Ping({});

      assert.equal(seen[0]?.authorization, 'Basic YWxpY2U6c2VjcmV0');
      assert.equal(seen[1]?.authorization, 'Bearer token-123');
    });
  });

  test.it('remote registry preserves auth across same-origin redirects', async () => {
    let redirectCount = 0;
    let targetAuth = '';

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        redirectCount += 1;
        res.writeHead(307, { Location: '/v2/target' });
        res.end();
        return;
      }

      if (req.method === 'GET' && url === '/v2/target') {
        targetAuth = req.headers.authorization ?? '';
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'secret',
        },
      });

      await registry.Ping({});

      assert.equal(redirectCount, 1);
      assert.equal(targetAuth, 'Basic YWxpY2U6c2VjcmV0');
    });
  });

  test.it('remote registry strips auth across cross-origin redirects', async () => {
    let targetAuth = '';

    await withServer((sinkReq, sinkRes) => {
      if (sinkReq.method === 'GET' && sinkReq.url === '/v2/target') {
        targetAuth = sinkReq.headers.authorization ?? '';
        sinkRes.writeHead(200);
        sinkRes.end();
        return;
      }

      sinkRes.writeHead(404);
      sinkRes.end();
    }, async (sinkHost) => {
      await withServer((req, res) => {
        const url = req.url ?? '';
        if (req.method === 'GET' && url === '/v2/') {
          res.writeHead(307, { Location: `http://${sinkHost}/v2/target` });
          res.end();
          return;
        }

        res.writeHead(404);
        res.end();
      }, async (originHost) => {
        const registry = new RemoteRegistry(originHost, {
          plainHTTP: true,
          basicAuth: {
            username: 'alice',
            password: 'secret',
          },
        });

        await registry.Ping({});

        assert.equal(targetAuth, '');
      });
    });
  });

  test.it('remote registry limits metadata response size', async () => {
    const oversized = JSON.stringify({ repositories: ['repo1', 'repo2'] });

    await withServer((req, res) => {
      if (req.url === '/v2/_catalog?n=100') {
        res.setHeader('Content-Type', 'application/json');
        res.end(oversized);
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        maxMetadataBytes: 4,
      });

      await assert.rejects(
        async () => {
          await registry.Repositories({}, '', async () => { });
        },
        /exceeds MaxMetadataBytes 4/,
      );
    });
  });

  test.it('remote registry exchanges bearer token from challenge', async () => {
    const manifestBytes = Buffer.from('{"manifests":[]}');
    const manifestDesc = createOciDescriptor({ mediaType: 'application/vnd.oci.image.index.v1+json', content: manifestBytes });
    let tokenRequests = 0;
    let manifestRequests = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        if (req.headers.authorization === 'Bearer exchange-token') {
          res.writeHead(200);
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url === '/auth/token') {
        tokenRequests += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          assert.match(body, /grant_type=password/);
          assert.match(body, /username=alice/);
          assert.match(body, /password=secret/);
          assert.match(body, /service=/);
          assert.match(body, /scope=repository%3Atest%3Apull/);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ access_token: 'exchange-token' }));
        });
        return;
      }

      if (req.method === 'HEAD' && url === `/v2/test/manifests/${manifestDesc.digest}`) {
        res.setHeader('Content-Type', manifestDesc.mediaType);
        res.setHeader('Docker-Content-Digest', manifestDesc.digest);
        res.setHeader('Content-Length', String(manifestDesc.size));
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'secret',
        },
        forceAttemptBearerExchange: true,
      });

      await registry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 2);
      assert.equal(registry.bearerToken, 'exchange-token');

      const cachedRegistry = new RemoteRegistry(host, { plainHTTP: true });
      await cachedRegistry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 3);
      assert.equal(cachedRegistry.bearerToken, 'exchange-token');
    });
  });

  test.it('remote registry switches from bearer to basic challenge', async () => {
    let tokenRequests = 0;
    let manifestRequests = 0;
    let bearerChallenge = true;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        const auth = req.headers.authorization;
        if (bearerChallenge) {
          if (auth === 'Bearer exchange-token') {
            res.writeHead(200);
            res.end();
            return;
          }
          res.writeHead(401, {
            'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
          });
          res.end();
          return;
        }

        if (auth === 'Basic YWxpY2U6c2VjcmV0') {
          res.writeHead(200);
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': 'Basic realm="Test Server"',
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url === '/auth/token') {
        tokenRequests += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          assert.match(body, /grant_type=password/);
          assert.match(body, /username=alice/);
          assert.match(body, /password=secret/);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ access_token: 'exchange-token' }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'secret',
        },
        forceAttemptBearerExchange: true,
      });

      await registry.Ping({});
      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 2);
      assert.equal(registry.bearerToken, 'exchange-token');

      bearerChallenge = false;
      await registry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 4);
    });
  });

  test.it('remote registry clears cached bearer token after switching to basic auth', async () => {
    let tokenRequests = 0;
    let manifestRequests = 0;
    let phase: 'bearer' | 'basic' = 'bearer';
    let basicAuthSucceeded = false;
    let thirdRequestAuth = '';

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        const auth = req.headers.authorization ?? '';

        if (phase === 'bearer') {
          if (auth === 'Bearer exchange-token') {
            res.writeHead(200);
            res.end();
            return;
          }

          res.writeHead(401, {
            'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
          });
          res.end();
          return;
        }

        if (auth === 'Basic YWxpY2U6c2VjcmV0') {
          basicAuthSucceeded = true;
          res.writeHead(200);
          res.end();
          return;
        }

        thirdRequestAuth = auth;
        if (auth === 'Bearer exchange-token') {
          res.writeHead(basicAuthSucceeded ? 403 : 401, {
            'Www-Authenticate': 'Basic realm="Test Server"',
          });
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': 'Basic realm="Test Server"',
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url === '/auth/token') {
        tokenRequests += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          assert.match(body, /grant_type=password/);
          assert.match(body, /username=alice/);
          assert.match(body, /password=secret/);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ access_token: 'exchange-token' }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const bearerRegistry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'secret',
        },
        forceAttemptBearerExchange: true,
      });

      await bearerRegistry.Ping({});
      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 2);
      assert.equal(bearerRegistry.bearerToken, 'exchange-token');

      phase = 'basic';

      const basicRegistry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'secret',
        },
      });

      await basicRegistry.Ping({});
      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 4);

      const anonymousRegistry = new RemoteRegistry(host, { plainHTTP: true });
      const response = await anonymousRegistry.request('GET', '/v2/');

      assert.equal(response.status, 401);
      assert.equal(thirdRequestAuth, '');
      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 5);
    });
  });

  test.it('remote registry reuses bearer cache across host case variants', async () => {
    const tokenRequests = new Set<string>();
    let manifestRequests = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        if (req.headers.authorization === 'Bearer case-token') {
          res.writeHead(200);
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.startsWith('/auth/token')) {
        tokenRequests.add(req.headers.host ?? '');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'case-token' }));
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const upperRegistry = new RemoteRegistry(host.replace('127.0.0.1', 'LOCALHOST'), { plainHTTP: true });
      await upperRegistry.Ping({});

      const lowerRegistry = new RemoteRegistry(host.replace('127.0.0.1', 'localhost'), { plainHTTP: true });
      await lowerRegistry.Ping({});

      assert.equal(tokenRequests.size, 1);
      assert.equal(manifestRequests, 3);
      assert.equal(lowerRegistry.bearerToken, 'case-token');
    });
  });

  test.it('remote registry returns 401 for invalid basic credentials', async () => {
    let requestCount = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        requestCount += 1;
        res.writeHead(401, {
          'Www-Authenticate': 'Basic realm="Test Server"',
        });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        basicAuth: {
          username: 'alice',
          password: 'bad',
        },
      });

      const response = await registry.request('GET', '/v2/');
      assert.equal(response.status, 401);
      assert.equal(requestCount, 2);
    });
  });

  test.it('remote registry fails on invalid bearer credential exchange', async () => {
    let tokenRequests = 0;
    let manifestRequests = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        if (req.headers.authorization === 'Bearer invalid-token') {
          res.writeHead(200);
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url === '/auth/token') {
        tokenRequests += 1;
        res.writeHead(401);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        refreshToken: 'bad-refresh-token',
      });

      await assert.rejects(async () => {
        await registry.Ping({});
      }, /failed to fetch bearer token: 401/);

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 1);
    });
  });

  test.it('remote registry fetches anonymous bearer tokens', async () => {
    let tokenRequests = 0;
    let manifestRequests = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        if (req.headers.authorization === 'Bearer anonymous-token') {
          res.writeHead(200);
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.startsWith('/auth/token')) {
        tokenRequests += 1;
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers.authorization ?? '', '');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'anonymous-token' }));
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, { plainHTTP: true });

      await registry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 2);
      assert.equal(registry.bearerToken, 'anonymous-token');

      const cachedRegistry = new RemoteRegistry(host, { plainHTTP: true });
      await cachedRegistry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 3);
      assert.equal(cachedRegistry.bearerToken, 'anonymous-token');
    });
  });

  test.it('remote registry exchanges refresh token from challenge', async () => {
    let tokenRequests = 0;
    let manifestRequests = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v2/') {
        manifestRequests += 1;
        if (req.headers.authorization === 'Bearer refresh-exchange-token') {
          res.writeHead(200);
          res.end();
          return;
        }

        res.writeHead(401, {
          'Www-Authenticate': `Bearer realm="/auth/token",service="${req.headers.host}",scope="repository:test:pull"`,
        });
        res.end();
        return;
      }

      if (req.method === 'POST' && url === '/auth/token') {
        tokenRequests += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          assert.match(body, /grant_type=refresh_token/);
          assert.match(body, /refresh_token=refresh-value/);
          assert.match(body, /service=/);
          assert.match(body, /scope=repository%3Atest%3Apull/);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ access_token: 'refresh-exchange-token' }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, {
        plainHTTP: true,
        refreshToken: 'refresh-value',
      });

      await registry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 2);
      assert.equal(registry.bearerToken, 'refresh-exchange-token');

      const cachedRegistry = new RemoteRegistry(host, { plainHTTP: true });
      await cachedRegistry.Ping({});

      assert.equal(tokenRequests, 1);
      assert.equal(manifestRequests, 3);
      assert.equal(cachedRegistry.bearerToken, 'refresh-exchange-token');
    });
  });

  test.it('remote repository resolve fetch tag and referrers', async () => {
    const manifestBytes = Buffer.from('{"manifests":[]}');
    const manifestDesc = createOciDescriptor({ mediaType: 'application/vnd.oci.image.index.v1+json', content: manifestBytes });
    const referrerDesc: OciDescriptor = {
      mediaType: 'application/vnd.oci.artifact.manifest.v1+json',
      digest: computeOciDigest('{"layers":[]}'),
      size: 13,
      artifactType: 'application/vnd.test',
    };

    let pushedManifest: Buffer | null = null;
    let pushedBlob: Buffer | null = null;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'HEAD' && url === `/v2/test/manifests/${manifestDesc.digest}`) {
        res.setHeader('Content-Type', manifestDesc.mediaType);
        res.setHeader('Docker-Content-Digest', manifestDesc.digest);
        res.setHeader('Content-Length', String(manifestDesc.size));
        res.end();
        return;
      }
      if (req.method === 'GET' && url === `/v2/test/manifests/${manifestDesc.digest}`) {
        res.setHeader('Content-Type', manifestDesc.mediaType);
        res.setHeader('Docker-Content-Digest', manifestDesc.digest);
        res.setHeader('Content-Length', String(manifestBytes.length));
        res.end(manifestBytes);
        return;
      }
      if (req.method === 'PUT' && url === '/v2/test/manifests/latest') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          pushedManifest = Buffer.concat(chunks);
          res.setHeader('Docker-Content-Digest', manifestDesc.digest);
          res.writeHead(201);
          res.end();
        });
        return;
      }
      if (req.method === 'POST' && url === '/v2/test/blobs/uploads/') {
        res.setHeader('Location', '/v2/test/blobs/uploads/uuid');
        res.writeHead(202);
        res.end();
        return;
      }
      if (req.method === 'PUT' && url.startsWith('/v2/test/blobs/uploads/uuid')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          pushedBlob = Buffer.concat(chunks);
          res.writeHead(201);
          res.end();
        });
        return;
      }
      if (req.method === 'GET' && url === `/v2/test/referrers/${manifestDesc.digest}?n=100&artifactType=application%2Fvnd.test`) {
        res.end(JSON.stringify(createOciImageIndex({ manifests: [referrerDesc] })));
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, { plainHTTP: true });
      const repo = registry.Repository('test');

      const resolved = await repo.Resolve({}, manifestDesc.digest);
      assert.equal(resolved.digest, manifestDesc.digest);
      assert.equal(resolved.mediaType, manifestDesc.mediaType);

      const fetched = await repo.FetchReference({}, manifestDesc.digest);
      assert.equal(fetched.desc.digest, manifestDesc.digest);
      const fetchedBody = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        fetched.stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        fetched.stream.once('end', () => resolve(Buffer.concat(chunks)));
        fetched.stream.once('error', reject);
      });
      assert.equal(fetchedBody.toString(), manifestBytes.toString());

      await repo.Tag({}, manifestDesc, 'latest');
      assert.equal(pushedManifest?.toString(), manifestBytes.toString());

      await repo.Push({}, { ...manifestDesc, mediaType: 'application/test.blob' }, Readable.from(['blob']));
      assert.equal(pushedBlob?.toString(), 'blob');

      const referrers: OciDescriptor[] = [];
      await repo.Referrers({}, manifestDesc, 'application/vnd.test', async (page) => {
        referrers.push(...page);
      });
      assert.deepEqual(referrers, [referrerDesc]);
    });
  });

  test.it('remote repository delete routes manifest and blob targets correctly', async () => {
    const manifestBytes = Buffer.from('{"manifests":[]}');
    const manifestDesc = createOciDescriptor({ mediaType: 'application/vnd.oci.image.index.v1+json', content: manifestBytes });
    const blobDesc = createOciDescriptor({ mediaType: 'application/test.blob', content: Buffer.from('blob') });
    const seen: string[] = [];

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === `/v2/test/manifests/${manifestDesc.digest}`) {
        seen.push(`fetch:${url}`);
        res.setHeader('Content-Type', manifestDesc.mediaType);
        res.setHeader('Docker-Content-Digest', manifestDesc.digest);
        res.setHeader('Content-Length', String(manifestBytes.length));
        res.end(manifestBytes);
        return;
      }

      if (req.method === 'DELETE' && url === `/v2/test/manifests/${manifestDesc.digest}`) {
        seen.push(`manifest:${url}`);
        res.writeHead(202);
        res.end();
        return;
      }
      if (req.method === 'DELETE' && url === `/v2/test/blobs/${blobDesc.digest}`) {
        seen.push(`blob:${url}`);
        res.writeHead(202);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, { plainHTTP: true });
      const repo = registry.Repository('test');

      await repo.Delete({}, manifestDesc);
      await repo.Delete({}, blobDesc);

      assert.deepEqual(seen, [
        `fetch:/v2/test/manifests/${manifestDesc.digest}`,
        `manifest:/v2/test/manifests/${manifestDesc.digest}`,
        `blob:/v2/test/blobs/${blobDesc.digest}`,
      ]);
    });
  });

  test.it('remote repository updates referrers index for manifest push and delete', async () => {
    const subjectDesc = createOciDescriptor({ mediaType: 'application/vnd.oci.image.manifest.v1+json', content: 'subject' });
    const referrerManifest = createOciImageManifest({
      config: {
        mediaType: 'application/test.config',
        content: 'config',
      },
      layers: [],
      subject: subjectDesc,
      artifactType: 'application/vnd.test',
    });
    const referrerManifestBytes = Buffer.from(JSON.stringify(referrerManifest));
    const referrerDesc = createOciDescriptor({ mediaType: referrerManifest.mediaType, content: referrerManifestBytes });
    const expectedReferrerDesc = { ...referrerDesc, artifactType: 'application/vnd.test' };
    const referrersTag = createOciReferrersTag(subjectDesc);
    const seen: string[] = [];
    let referrersIndexBytes: Buffer | null = null;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'PUT' && url === `/v2/test/manifests/${referrerDesc.digest}`) {
        seen.push(`push:${url}`);
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          assert.equal(body.toString(), referrerManifestBytes.toString());
          res.setHeader('Docker-Content-Digest', referrerDesc.digest);
          res.writeHead(201);
          res.end();
        });
        return;
      }

      if (req.method === 'GET' && url === `/v2/test/manifests/${referrerDesc.digest}`) {
        seen.push(`fetch:${url}`);
        res.setHeader('Content-Type', referrerDesc.mediaType);
        res.setHeader('Docker-Content-Digest', referrerDesc.digest);
        res.setHeader('Content-Length', String(referrerManifestBytes.length));
        res.end(referrerManifestBytes);
        return;
      }

      if (req.method === 'DELETE' && url === `/v2/test/manifests/${referrerDesc.digest}`) {
        seen.push(`delete:${url}`);
        res.writeHead(202);
        res.end();
        return;
      }

      if (req.method === 'GET' && url === `/v2/test/manifests/${referrersTag}`) {
        if (!referrersIndexBytes) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/vnd.oci.image.index.v1+json');
        res.setHeader('Docker-Content-Digest', computeOciDigest(referrersIndexBytes));
        res.setHeader('Content-Length', String(referrersIndexBytes.length));
        res.end(referrersIndexBytes);
        return;
      }

      if (req.method === 'PUT' && url === `/v2/test/manifests/${referrersTag}`) {
        seen.push(`index:${url}`);
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          referrersIndexBytes = Buffer.concat(chunks);
          res.setHeader('Docker-Content-Digest', computeOciDigest(referrersIndexBytes));
          res.writeHead(201);
          res.end();
        });
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, { plainHTTP: true, skipReferrersGC: true });
      const repo = registry.Repository('test');

      await repo.PushReference({}, referrerDesc, referrerManifestBytes, referrerDesc.digest);
      assert.ok(referrersIndexBytes);
      assert.deepEqual(JSON.parse(referrersIndexBytes.toString()), createOciImageIndex({ manifests: [expectedReferrerDesc] }));

      await repo.Delete({}, referrerDesc);
      assert.ok(referrersIndexBytes);
      assert.deepEqual(JSON.parse(referrersIndexBytes.toString()), createOciImageIndex({ manifests: [] }));

      assert.deepEqual(seen, [
        `push:/v2/test/manifests/${referrerDesc.digest}`,
        `index:/v2/test/manifests/${referrersTag}`,
        `fetch:/v2/test/manifests/${referrerDesc.digest}`,
        `delete:/v2/test/manifests/${referrerDesc.digest}`,
        `index:/v2/test/manifests/${referrersTag}`,
      ]);
    });
  });

  test.it('remote repository referrers fall back to tag schema when unsupported', async () => {
    const manifestBytes = Buffer.from('{"manifests":[]}');
    const manifestDesc = createOciDescriptor({ mediaType: 'application/vnd.oci.image.index.v1+json', content: manifestBytes });
    const referrerDesc: OciDescriptor = {
      mediaType: 'application/vnd.oci.artifact.manifest.v1+json',
      digest: computeOciDigest('{"layers":[]}'),
      size: 13,
      artifactType: 'application/vnd.test',
    };
    const referrersTag = createOciReferrersTag(manifestDesc);
    let apiCalls = 0;
    let tagCalls = 0;

    await withServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === `/v2/test/referrers/${manifestDesc.digest}?n=100&artifactType=application%2Fvnd.test`) {
        apiCalls += 1;
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'GET' && url === `/v2/test/manifests/${referrersTag}`) {
        tagCalls += 1;
        res.setHeader('Content-Type', 'application/vnd.oci.image.index.v1+json');
        res.end(JSON.stringify(createOciImageIndex({ manifests: [referrerDesc] })));
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (host) => {
      const registry = new RemoteRegistry(host, { plainHTTP: true });
      const repo = registry.Repository('test') as RemoteRepository;
      repo.SetReferrersCapability(false);

      const referrers: OciDescriptor[] = [];
      await repo.Referrers({}, manifestDesc, 'application/vnd.test', async (page) => {
        referrers.push(...page);
      });

      assert.deepEqual(referrers, [referrerDesc]);
      assert.equal(apiCalls, 0);
      assert.equal(tagCalls, 1);

      assert.throws(() => repo.SetReferrersCapability(true));
    });
  });
});

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
