# toci

TypeScript OCI primitives and client, modeled after [oras-go](https://github.com/oras-project/oras-go).

## Features

- **OCI primitives** — descriptors, digests, manifests, image indexes, and referrers helpers with validation
- **Packing** — create OCI image manifests, artifact manifests, and indexes from content
- **Stores** — in-memory store and file-backed OCI layout store
- **Repositories** — full repository interfaces for blobs, manifests, tags, and referrers
- **Remote client** — registry client with auth headers, bearer challenge exchange, token caching, redirect safety, and referrers tag-schema indexing
- **Auth** — login/logout, docker-config-backed credential stores, native credential helpers, and static credentials
- **Middleware** — policy enforcement decorators for repositories and stores

## Install

```sh
pnpm add @quayr/toci
```

Requires Node.js >= 26.

## Quick start

```ts
import { MemoryStore, createOciImageManifest, computeOciDigest } from '@quayr/toci';

const store = new MemoryStore();

const manifest = createOciImageManifest({
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', content: '{}' },
  layers: [],
});

const bytes = JSON.stringify(manifest);
const digest = computeOciDigest(bytes);
await store.Push({}, { mediaType: manifest.mediaType, digest, size: bytes.length }, bytes);
```

## Documentation

API reference is generated with [TypeDoc](https://typedoc.org/):

```sh
pnpm run docs:build
```

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## License

ISC