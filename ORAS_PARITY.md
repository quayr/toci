# TOCI / oras-go parity

This file tracks the slice of oras-go functionality that has already been ported into `packages/toci` and the remaining gaps.

## Implemented

- OCI descriptor, digest, manifest, and index helpers in `src/oci.ts`
- Pack/manifest creation flows in `src/pack.ts`
- File-backed OCI layout storage in `src/store.ts`
- In-memory store in `src/memory.ts`
- Repository interfaces and helpers in `src/registry.ts` and `src/repository.ts`
- Policy enforcement middleware in `src/middleware.ts`, including wrapped sub-stores
- Auth helper surface in `src/auth.ts`, including docker.io registry/server-address mapping and static credential matching
- Basic login/logout and credential-store wiring in `src/auth.ts`
- Docker-config-backed credential store loading in `src/auth.ts`
- Native credential helpers in `src/auth.ts`, including helper construction, protocol-compatible get/put/delete, and platform-default helper selection with Linux helper-path probing
- Fallback credential-store composition in `src/auth.ts`
- Docker-config-backed dynamic credential store routing in `src/auth.ts`, including helper-backed writes, plaintext fallback writes, and detected-helper persistence
- Docker-config-backed credential-store edge cases in `src/auth.ts`, including rejecting plaintext writes when disabled and deleting plaintext auth entries
- Remote registry client in `src/remote.ts`, including custom headers, auth headers, bearer challenge exchange, anonymous and refresh-token minting, bearer/basic scheme switching, scheme-aware bearer token cache invalidation, host-canonicalized bearer token caching, token caching, bounded retries, metadata byte limiting, and referrers tag-schema indexing on push/delete
- Remote registry redirect safety in `src/remote.ts`, including same-origin auth preservation and cross-origin auth stripping

## Still missing or partial

- A few remaining credential-manager edge cases
- Full registry middleware parity around error wrapping and capability negotiation edge cases
- Additional content-store variants beyond memory and OCI layout
- Some of the finer-grained oras-go validation and referrer edge cases
- Some remaining auth/login and capability-negotiation edge cases around the remote client
- Any remaining redirect and credential-forwarding edge cases around remote requests

## Next likely slices

1. Add the remaining credential-manager edge cases.
2. Add any missing content-store helpers that mirror oras-go more closely.
3. Expand the parity tests for auth/login and middleware edge cases.
