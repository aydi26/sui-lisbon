// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0
// @status     DONE
// @spec       docs/RECON.md#r8 (event module/struct names), #r5 (Hashi package id)
// @spec       docs/KEEPER.md §2.3 (`queryEvents` filtered by MoveEventType)
// @rules      G7
// @depends    ../config.ts (T0.6) · ./types.ts
// @facts      A Move event type tag is `<package>::<module>::<Struct>[<type args>]`.
// @facts      `treasury::Minted<T>` / `Burned<T>` are GENERIC — a MoveEventType filter needs the
// @facts        instantiated tag `<pkg>::treasury::Minted<<pkg>::btc::BTC>`; the other 12 are not.
// @facts      Package id and hBTC coin type ALWAYS arrive from Config — never a literal here (G7).
// @implements export function hashiEventTypeTag(cfg: Config, kind: HashiEventKind): string
// @implements export function hashiEventTypes(cfg: Config): Readonly<Record<HashiEventKind, string>>
// @implements export function hashiEventTypeFilters(cfg: Config): Readonly<Record<HashiEventKind, string>>
// @implements export function baseTypeTag(typeTag: string): string
// @implements export function parseHashiEventKind(cfg: Config, typeTag: string): HashiEventKind | undefined
// @forbidden  a hardcoded package id or module path anywhere in this file — G7
// @invariant  1. hashiEventTypeTag(cfg, k) is prefixed by `${cfg.hashi.packageId}::`.
// @invariant  2. parseHashiEventKind(cfg, hashiEventTypeFilters(cfg)[k]) === k for every kind.
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';

import { HASHI_EVENT_KINDS, HASHI_EVENT_MODULE, type HashiEventKind } from './types.js';

/** `<hashiPkg>::<module>::<Struct>` — no type arguments. */
export function hashiEventTypeTag(cfg: Config, kind: HashiEventKind): string {
  return `${cfg.hashi.packageId}::${HASHI_EVENT_MODULE[kind]}::${kind}`;
}

/** Base (un-instantiated) tag for every kind. Use for MATCHING incoming events. */
export function hashiEventTypes(cfg: Config): Readonly<Record<HashiEventKind, string>> {
  const out = {} as Record<HashiEventKind, string>;
  for (const kind of HASHI_EVENT_KINDS) {
    out[kind] = hashiEventTypeTag(cfg, kind);
  }
  return Object.freeze(out);
}

/**
 * Tags suitable for a `MoveEventType` QUERY filter: identical to {@link hashiEventTypes}
 * except that the two generic treasury events are instantiated at the hBTC coin type.
 */
export function hashiEventTypeFilters(cfg: Config): Readonly<Record<HashiEventKind, string>> {
  const base = hashiEventTypes(cfg);
  return Object.freeze({
    ...base,
    Minted: `${base.Minted}<${cfg.hashi.hbtcCoinType}>`,
    Burned: `${base.Burned}<${cfg.hashi.hbtcCoinType}>`,
  });
}

/** Strip generic arguments: `a::b::C<d::e::F>` -> `a::b::C`. */
export function baseTypeTag(typeTag: string): string {
  const lt = typeTag.indexOf('<');
  return lt === -1 ? typeTag : typeTag.slice(0, lt);
}

/** Reverse lookup. Returns `undefined` for any type that is not a Hashi event of this package. */
export function parseHashiEventKind(cfg: Config, typeTag: string): HashiEventKind | undefined {
  const base = baseTypeTag(typeTag);
  for (const kind of HASHI_EVENT_KINDS) {
    if (base === hashiEventTypeTag(cfg, kind)) return kind;
  }
  return undefined;
}

/** Extract the first generic argument of a type tag, e.g. the coin type of `Minted<T>`. */
export function typeArgOf(typeTag: string): string | undefined {
  const lt = typeTag.indexOf('<');
  const gt = typeTag.lastIndexOf('>');
  if (lt === -1 || gt === -1 || gt < lt) return undefined;
  return typeTag.slice(lt + 1, gt);
}
