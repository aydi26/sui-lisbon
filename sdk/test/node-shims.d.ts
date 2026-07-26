// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.0
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 (the sdk has exactly TWO devDeps: vitest + typescript)
// @rules      G10
// @facts      The TEST suite reads fixtures from disk and validates BLAKE2b against OpenSSL.
// @facts        That needs `node:fs`, `node:url`, `node:crypto` and `import.meta.url` — four
// @facts        things `@types/node` would provide, at the cost of a third devDependency.
// @facts        Declaring the handful of members actually used keeps the dependency count at
// @facts        two, which is the property `test/index.test.ts` asserts.
// @facts      ⚠ TEST-ONLY. `src/` imports NO node builtin — test/index.test.ts greps for that,
// @facts        because this package is bundled into the browser app.
// @facts      OpenSSL exposes blake2b512 and blake2s256 but NOT blake2b256 (it needs a digest-
// @facts        length parameter), so parity is asserted on blake2b512 and the 256-bit digest
// @facts        length is pinned by published KATs.
// @implements declare module 'node:crypto' | 'node:fs' | 'node:url'
// @implements interface ImportMeta { url: string }
// @forbidden  importing any node builtin from src/
// @verify     npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

declare module 'node:crypto' {
  export interface AphoticHash {
    update(data: Uint8Array): AphoticHash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): AphoticHash;
  export function randomBytes(size: number): Uint8Array;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

interface ImportMeta {
  readonly url: string;
}
