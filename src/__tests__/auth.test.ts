import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CredentialMemoryStore,
  DockerConfigCredentialStore,
  FallbackCredentialStore,
  GetCredentialFunc,
  Login,
  Logout,
  NewDefaultNativeCredentialStore,
  NewDockerConfigCredentialStore,
  NewDockerConfigCredentialStoreFromDocker,
  NewFallbackCredentialStore,
  NewMemoryCredentialStoreFromDockerConfig,
  NewNativeCredentialStore,
  ServerAddressFromHostname,
  ServerAddressFromRegistry,
  StaticCredentialFunc,
  type Credential
} from '../auth';

test.describe('auth', () => {
  let tempDir: string;
  let configPath: string;

  test.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toci-docker-config-'));
    configPath = path.join(tempDir, 'config.json');
  });

  test.afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test.it('server address helpers match oras-style docker.io mapping', () => {
    assert.equal(ServerAddressFromRegistry('docker.io'), 'https://index.docker.io/v1/');
    assert.equal(ServerAddressFromRegistry('registry-1.docker.io'), 'https://index.docker.io/v1/');
    assert.equal(ServerAddressFromRegistry('ghcr.io'), 'ghcr.io');

    assert.equal(ServerAddressFromHostname('registry-1.docker.io'), 'https://index.docker.io/v1/');
    assert.equal(ServerAddressFromHostname('ghcr.io'), 'ghcr.io');
  });

  test.it('StaticCredentialFunc matches exact registry targets and docker.io aliasing', () => {
    const cred: Credential = {
      username: 'username',
      password: 'password'
    };

    const regular = StaticCredentialFunc('registry.example.com', cred);
    const docker = StaticCredentialFunc('docker.io', cred);

    assert.deepEqual(regular({}, 'registry.example.com'), cred);
    assert.deepEqual(regular({}, 'Registry.example.com'), {});
    assert.deepEqual(regular({}, 'other.example.com'), {});
    assert.deepEqual(docker({}, 'registry-1.docker.io'), cred);
    assert.deepEqual(docker({}, 'docker.io'), {});
  });

  test.it('GetCredentialFunc returns empty credentials when store is missing', () => {
    const fn = GetCredentialFunc(undefined);
    assert.deepEqual(fn({}, 'registry.example.com'), {});
  });

  test.it('Login validates and stores credentials using registry mapping', async () => {
    const calls: Array<{ op: string; serverAddress: string; cred?: Credential }> = [];
    const store = {
      async Get() {
        return {};
      },
      async Put(_ctx: unknown, serverAddress: string, cred: Credential) {
        calls.push({ op: 'put', serverAddress, cred });
      },
      async Delete(_ctx: unknown, serverAddress: string) {
        calls.push({ op: 'delete', serverAddress });
      }
    };

    await Login({}, store, {
      host: 'docker.io',
      plainHTTP: false,
      headers: {},
      forceAttemptBearerExchange: false,
      repositoryListPageSize: 100,
      repositoryListMaxPages: 0,
      tagListPageSize: 100,
      referrerListPageSize: 100,
      skipReferrersGC: false,
      maxMetadataBytes: 4 * 1024 * 1024,
      retryAttempts: 2,
      retryDelayMs: 0,
      async Ping() {
        return;
      }
    }, {
      username: 'alice',
      password: 'secret'
    });

    assert.deepEqual(calls, [
      { op: 'put', serverAddress: 'https://index.docker.io/v1/', cred: { username: 'alice', password: 'secret' } }
    ]);
  });

  test.it('Logout deletes the registry-mapped credential', async () => {
    const deleted: string[] = [];
    const store = {
      async Get() {
        return {};
      },
      async Delete(_ctx: unknown, serverAddress: string) {
        deleted.push(serverAddress);
      }
    };

    await Logout({}, store, 'registry-1.docker.io');
    assert.deepEqual(deleted, ['https://index.docker.io/v1/']);
  });

  test.it('CredentialMemoryStore round trips and docker config keys normalize', () => {
    const store = new CredentialMemoryStore({
      'registry.example.com': {
        username: 'alice',
        password: 'secret'
      }
    });

    assert.deepEqual(store.Get({}, 'registry.example.com'), {
      username: 'alice',
      password: 'secret'
    });

    store.Put!({}, 'https://registry.example.com/', {
      refreshToken: 'refresh-token'
    });
    assert.deepEqual(store.Get({}, 'https://registry.example.com/'), {
      refreshToken: 'refresh-token'
    });

    store.Delete!({}, 'registry.example.com');
    assert.deepEqual(store.Get({}, 'registry.example.com'), {});
  });

  test.it('NewMemoryCredentialStoreFromDockerConfig loads auth and legacy credentials', () => {
    const config = JSON.stringify({
      auths: {
        'https://index.docker.io/v1/': {
          auth: Buffer.from('docker-user:docker-pass').toString('base64')
        },
        'https://registry.example.com/': {
          username: 'legacy-user',
          password: 'legacy-pass',
          identitytoken: 'refresh-token',
          registrytoken: 'access-token'
        }
      }
    });

    const store = NewMemoryCredentialStoreFromDockerConfig(config);
    assert.deepEqual(store.Get({}, 'index.docker.io'), {
      username: 'docker-user',
      password: 'docker-pass',
    });
    assert.deepEqual(store.Get({}, 'registry.example.com'), {
      username: 'legacy-user',
      password: 'legacy-pass',
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
    });
  });

  test.it('NewNativeCredentialStore follows helper protocol for basic and token credentials', async () => {
    const calls: Array<{ action: string; input: string }> = [];
    const store: any = NewNativeCredentialStore({
      async Execute(_ctx: unknown, input: string, action: 'get' | 'store' | 'erase') {
        calls.push({ action, input });
        if (action === 'get') {
          return { stdout: JSON.stringify({ Username: 'user', Secret: 'pass' }) };
        }
        return { stdout: '' };
      }
    });

    await store.Put({}, 'registry.example.com', { username: 'user', password: 'pass' });
    const basic = await store.Get({}, 'registry.example.com');
    await store.Put({}, 'registry.example.com', { refreshToken: 'refresh' });
    const token = await store.Get({}, 'registry.example.com');
    await store.Delete({}, 'registry.example.com');

    assert.deepEqual(basic, { username: 'user', password: 'pass' });
    assert.deepEqual(token, { username: 'user', password: 'pass' });
    assert.deepEqual(calls.map((entry) => entry.action), ['store', 'get', 'store', 'get', 'erase']);
  });

  test.it('NewDefaultNativeCredentialStore reports availability by platform helper', () => {
    const [store, ok] = NewDefaultNativeCredentialStore();
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(ok, true);
      assert.ok(store);
      return;
    }

    if (process.platform === 'linux') {
      assert.equal(ok, hasCommand('docker-credential-pass') || hasCommand('docker-credential-secretservice'));
      if (ok) {
        assert.ok(store);
      } else {
        assert.equal(store, null);
      }
      return;
    }

    assert.equal(ok, false);
    assert.equal(store, null);
  });

  test.it('FallbackCredentialStore reads from fallbacks and writes to primary only', async () => {
    const primaryReads: string[] = [];
    const primaryWrites: Array<{ op: string; serverAddress: string }> = [];
    const fallbackReads: string[] = [];

    const primary = {
      async Get(_ctx: unknown, serverAddress: string) {
        primaryReads.push(serverAddress);
        return {};
      },
      async Put(_ctx: unknown, serverAddress: string) {
        primaryWrites.push({ op: 'put', serverAddress });
      },
      async Delete(_ctx: unknown, serverAddress: string) {
        primaryWrites.push({ op: 'delete', serverAddress });
      }
    };

    const fallback = {
      async Get(_ctx: unknown, serverAddress: string) {
        fallbackReads.push(serverAddress);
        return { username: 'fallback-user', password: 'fallback-pass' };
      },
      async Put() {
        throw new Error('fallback put should not be called');
      },
      async Delete() {
        throw new Error('fallback delete should not be called');
      }
    };

    const store = new FallbackCredentialStore(primary, [fallback]);

    const cred = await store.Get({}, 'registry.example.com');
    await store.Put({}, 'registry.example.com', { username: 'alice', password: 'secret' });
    await store.Delete({}, 'registry.example.com');

    assert.deepEqual(cred, { username: 'fallback-user', password: 'fallback-pass' });
    assert.deepEqual(primaryReads, ['registry.example.com']);
    assert.deepEqual(fallbackReads, ['registry.example.com']);
    assert.deepEqual(primaryWrites, [
      { op: 'put', serverAddress: 'registry.example.com' },
      { op: 'delete', serverAddress: 'registry.example.com' },
    ]);
  });

  test.it('NewFallbackCredentialStore returns the primary store when there are no fallbacks', () => {
    const primary = new CredentialMemoryStore();
    assert.equal(NewFallbackCredentialStore(primary), primary);
  });

  test.it('DockerConfigCredentialStore writes plaintext auth when no helper is configured', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ some_config_field: 123 }, null, 2));

    const store = NewDockerConfigCredentialStore(configPath, {
      allowPlaintextPut: true,
    });

    const cred: Credential = {
      username: 'alice',
      password: 'secret',
      refreshToken: 'refresh-token',
    };

    await store.Put!({}, 'registry.example.com', cred);
    assert.deepEqual(await store.Get({}, 'registry.example.com'), cred);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      some_config_field: 123,
      auths: {
        'registry.example.com': {
          username: 'alice',
          password: 'secret',
          identitytoken: 'refresh-token',
          auth: Buffer.from('alice:secret').toString('base64'),
        },
      },
    });
  });

  test.it('DockerConfigCredentialStore rejects plaintext writes when disabled', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ some_config_field: 123 }, null, 2));

    const store = NewDockerConfigCredentialStore(configPath, {
      allowPlaintextPut: false,
    });

    await assert.rejects(
      () => store.Put!({}, 'registry.example.com', { username: 'alice', password: 'secret' }),
      /putting plaintext credentials is disabled/,
    );
  });

  test.it('DockerConfigCredentialStore deletes plaintext auth entries', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      auths: {
        'registry.example.com': {
          username: 'alice',
          password: 'secret',
        },
      },
    }, null, 2));

    const store = NewDockerConfigCredentialStore(configPath, {
      allowPlaintextPut: true,
    });

    await store.Delete!({}, 'registry.example.com');
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      auths: {},
    });
  });

  test.it('DockerConfigCredentialStore routes to the configured native helper store', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ credsStore: 'test-helper' }, null, 2));

    const nativeStore = new CredentialMemoryStore();
    const store = NewDockerConfigCredentialStore(configPath, {
      allowPlaintextPut: true,
      nativeStoreFactory: () => nativeStore,
    });

    const cred: Credential = {
      username: 'helper-user',
      password: 'helper-pass',
    };

    await store.Put!({}, 'registry.example.com', cred);
    assert.deepEqual(await store.Get({}, 'registry.example.com'), cred);
    await store.Delete!({}, 'registry.example.com');
    assert.deepEqual(await store.Get({}, 'registry.example.com'), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      credsStore: 'test-helper',
    });
  });

  test.it('DockerConfigCredentialStore persists a detected helper on first write', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ some_config_field: 123 }, null, 2));

    const helperDir = path.join(tempDir, 'helper');
    fs.mkdirSync(helperDir);
    const helperPath = path.join(helperDir, 'docker-credential-pass');
    fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helperPath, 0o755);

    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${helperDir}${path.delimiter}${originalPath}`;

    try {
      const nativeStore = new CredentialMemoryStore();
      const store = NewDockerConfigCredentialStore(configPath, {
        allowPlaintextPut: true,
        detectDefaultNativeStore: true,
        nativeStoreFactory: () => nativeStore,
      });

      const cred: Credential = {
        username: 'detected-user',
        password: 'detected-pass',
      };

      await store.Put!({}, 'registry.example.com', cred);
      assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).credsStore, 'pass');
      assert.deepEqual(await store.Get({}, 'registry.example.com'), cred);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test.it('NewDockerConfigCredentialStoreFromDocker resolves the docker config path', () => {
    const originalDockerConfig = process.env.DOCKER_CONFIG;
    process.env.DOCKER_CONFIG = tempDir;

    try {
      const store = NewDockerConfigCredentialStoreFromDocker();
      assert.equal(store.ConfigPath(), path.join(tempDir, 'config.json'));
      assert.ok(store instanceof DockerConfigCredentialStore);
    } finally {
      if (originalDockerConfig === undefined) {
        delete process.env.DOCKER_CONFIG;
      } else {
        process.env.DOCKER_CONFIG = originalDockerConfig;
      }
    }
  });
});

function hasCommand(commandName: string): boolean {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    try {
      fs.accessSync(path.join(entry, commandName), fs.constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}
