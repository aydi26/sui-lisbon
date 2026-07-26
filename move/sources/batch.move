module aphotic::batch;

use aphotic::caps::{Self, CapRegistry, AdminCap};
use aphotic::events;
use aphotic::oracle;
use sui::bcs::{Self, BCS};
use sui::clock::Clock;
use sui::hash;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.2-the-batch (L335-L347)
// @spec       aphotic.md#7.3-cadence (L349-L353)
// @spec       aphotic.md#2-hard-constraints (L53, L57)  <- nothing readable before close;
//             timing is mechanical and an operator may never choose when a batch closes
// @spec       aphotic.md#10-invariants (L452-L455)      <- the Batch invariants
// @spec       docs/DESIGN-V2.md#3-the-seal_approve-entry-exactly
// @spec       docs/DESIGN-V2.md#4-timing-is-mechanical-not-operator-chosen
// @rules      G10
// @depends    aphotic::caps · aphotic::events · aphotic::oracle (saturating arithmetic)
// @facts      STATE MACHINE, STRICTLY MONOTONIC:  OPEN(0) → SEALED(1) → CLEARING(2) → SETTLED(3)
// @facts        `set_state` is the ONE writer and asserts `new > old`, so no path returns to
// @facts        OPEN and no path skips backwards. All sixteen ordered pairs are tested.
// @facts      CADENCE  cadence_ms = 43_200_000 (12 h), offset_ms = 21_600_000 (6 h)
// @facts        ⇒ 06:00 and 18:00 UTC daily, because unix epoch day 0 begins 00:00 UTC.
// @facts        `open_batch` takes NO timestamp parameter — `close_ms` is DERIVED by
// @facts        `next_boundary`, which is what removes the operator's timing lever.
// @facts      A FULL BATCH DOES NOT CLOSE EARLY. Closing on fullness would hand a spammer
// @facts        exactly the timing lever uniform-price clearing exists to remove: a full batch
// @facts        rejects further submits (EBatchFull) and still closes on the boundary.
// @facts      SUBMIT_CUTOFF_MS = 60_000 — no submit lands within a minute of close, so a submit
// @facts        can never race an early key release.
// @facts      REVEAL_GRACE_MS = 600_000 — ten minutes, two orders of magnitude more than the
// @facts        observed skew between Seal key servers.
// @facts      ⚠ THE REVEAL INSTANT IS NOT EXACT. Key servers dry-run the PTB and prepend a
// @facts        2-minute staleness check, and they skew by seconds. NOTHING here depends on an
// @facts        exact instant: `close_batch` reads the ON-CHAIN Clock, so the transition is
// @facts        exact regardless, and an early leak of ≤2 min reveals orders that can no longer
// @facts        be joined (submits stopped a minute earlier).
// @facts      SEAL INNER IDENTITY, 48 BYTES. Full IBE identity is `bytes(packageId) ‖ inner`;
// @facts        `seal_approve` receives ONLY `inner`:
// @facts          [ 0..8 )  bcs u64  close_ms        LITTLE-ENDIAN
// @facts          [ 8..16)  bcs u64  policy_version  LITTLE-ENDIAN
// @facts          [16..48)  bcs address  batch object id (32 raw bytes)
// @facts          leftovers MUST be empty
// @facts      ⚠⚠ LITTLE-ENDIAN IS THE TRAP. `bcs::peel_u64` reads LE. The v1 vault decoded the
// @facts        Seal epoch BIG-endian (`epoch = (epoch << 8) + byte`). A big-endian identity
// @facts        produces a policy that NEVER opens and fails SILENTLY — the key server simply
// @facts        declines. Structural twin of RECON R14.2's reversed Bitcoin txid.
// @facts        `seal_approve_le_golden` / `seal_approve_rejects_big_endian_identity` pin it.
// @facts      THE `leftovers.length() == 0` CHECK IS MANDATORY, not stylistic: without it the
// @facts        policy accepts identities that were never intended (upstream `tle.move`).
// @facts      VERSIONING IS OURS, NOT UPSTREAM'S. `tle.move` explicitly does not implement it;
// @facts        our package is upgradeable, so `policy_version` is part of the identity and is
// @facts        checked. Bumping it while a batch is live is refused (EPolicyBumpWithLiveBatch),
// @facts        so a bump can never orphan orders that are already encrypted.
// @facts      KEY-SERVER CONSTRAINTS ALL SATISFIED: 1 command (≤100), a `MoveCall` into our own
// @facts        package, the name is prefixed `seal_approve`, the first argument is a non-empty
// @facts        `Pure`, the function is side-effect free, and denial is by ABORT.
// @facts      NO SENDER CHECK IN THE POLICY. A batch time-lock must be satisfiable by ANYONE
// @facts        after T — that is what makes reveal permissionless and kills the
// @facts        grief-by-non-revelation failure that sank commit–reveal (spec §3).
// @facts      THE COMMITMENT BINDS THE PLAINTEXT: `commitment = blake2b256(bcs(Order))`. If only
// @facts        `ct_hash` were binding, a submitter could publish one ciphertext and later claim
// @facts        a different plaintext decrypted out of it. `ct_hash` and `blob_id` exist only so
// @facts        a third party can FIND the ciphertext.
// @facts      MAX_BATCH_SIZE governed, default 256, HARD_MAX_BATCH_SIZE = 512. Justified in
// @facts        aphotic::clearing's banner against the 1_000-store-entry wall.
// @external   (none — Seal is an off-chain SDK. The only on-chain Seal surface in this package
//             is `seal_approve` below, and it calls nothing.)
// @implements public fun create_registry(vault_id: ID, ctx): BatchRegistry
//             public fun share_registry(r: BatchRegistry)
//             public fun next_boundary(now_ms, cadence_ms, offset_ms): u64
//             public fun open_batch(r: &mut BatchRegistry, clock, ctx): Batch
//             public fun share_batch(b: Batch)
//             public fun submit_order(b: &mut Batch, commitment, ct_hash, blob_id, clock, ctx)
//             public fun close_batch(b: &mut Batch, clock)
//             public fun reveal_order(b: &mut Batch, index: u64, order: Order, clock)
//             public fun new_order(submitter, is_bid, limit_price, qty_sats, salt): Order
//             public fun order_commitment(o: &Order): vector<u8>
//             public fun seal_identity(close_ms, policy_version, batch: address): vector<u8>
//             public fun check_policy(id, r: &BatchRegistry, c: &Clock): bool
//             entry  fun seal_approve(id, r: &BatchRegistry, c: &Clock)
//             public fun set_cadence / set_max_batch_size / set_policy_version
//                 / set_submit_cutoff_ms / set_reveal_grace_ms  (&CapRegistry + &AdminCap)
//             public(package) fun to_clearing(b: &mut Batch, clock)
//             public(package) fun to_settled(b: &mut Batch, r: &mut BatchRegistry)
// @events     BatchOpened · OrderSubmitted · BatchClosed  (declared in aphotic::events)
// @errors     EBadState · ETooEarly · ESubmitWindowClosed · EBatchFull · ECommitmentMismatch
//             · ESubmitterMismatch · EAlreadyRevealed · ERevealWindowClosed · ERevealWindowOpen
//             · ENonMonotonic · EPolicyBumpWithLiveBatch · EBatchAlreadyLive · EVaultMismatch
//             · EBadDigestLength · EBadOrder · EIndexOutOfRange · EBadParam · ENoAccess
//             · EWrongRegistry
// @forbidden  an AMOUNT, SIDE or PRICE field on `SealedOrder` — hard constraint §2.3. What
//             lands on chain before close is a commitment, a ciphertext hash, a Walrus locator
//             and the submitter (who IS the internal-balance reference), and nothing else.
// @forbidden  a `close_ms` PARAMETER on `open_batch` — hard constraint §2.7, timing is
//             mechanical. It is derived by `next_boundary` and by nothing else.
// @forbidden  closing a batch because it filled up — see @facts
// @forbidden  a sender check inside `check_policy` — DESIGN-V2 F2
// @forbidden  any mutation or event inside `seal_approve` — the key server DRY-RUNS it and
//             requires it to be side-effect free
// @forbidden  a second writer of `Batch.state` — only `set_state` assigns it
// @invariant  1. `close_batch` reverts before `close_ms` (ETooEarly), and succeeds at exactly
//                `close_ms` — the boundary is `>=`.
// @invariant  2. No entry function reveals order contents while the state is OPEN. `reveal_order`
//                asserts SEALED and every plaintext accessor asserts the state is past OPEN.
// @invariant  3. Transitions are monotonic. Every one of the sixteen ordered pairs is tested.
// @invariant  4. `close_ms` is derived, never supplied.
// @invariant  5. A full batch rejects submits and does NOT close early.
// @invariant  6. `seal_approve` accepts the LITTLE-ENDIAN identity and rejects the big-endian
//                encoding of the same timestamp, an identity with trailing bytes, and an
//                identity carrying a stale `policy_version`.
// @invariant  7. `policy_version` cannot be bumped while any batch is live.
// @ac         move/tests/batch_tests.move — every invariant above has a named test
// @verify     sui move build
// @verify     sui move test batch
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const EBadState: u64 = 1;
const ETooEarly: u64 = 2;
const ESubmitWindowClosed: u64 = 3;
const EBatchFull: u64 = 4;
const ECommitmentMismatch: u64 = 5;
const ESubmitterMismatch: u64 = 6;
const EAlreadyRevealed: u64 = 7;
const ERevealWindowClosed: u64 = 8;
const ERevealWindowOpen: u64 = 9;
const ENonMonotonic: u64 = 10;
const EPolicyBumpWithLiveBatch: u64 = 11;
const EBatchAlreadyLive: u64 = 12;
const EVaultMismatch: u64 = 13;
const EBadDigestLength: u64 = 14;
const EBadOrder: u64 = 15;
const EIndexOutOfRange: u64 = 16;
const EBadParam: u64 = 17;
const ENoAccess: u64 = 18;
const EWrongRegistry: u64 = 19;

// ── the state machine ───────────────────────────────────────────────────────
const STATE_OPEN: u8 = 0;
const STATE_SEALED: u8 = 1;
const STATE_CLEARING: u8 = 2;
const STATE_SETTLED: u8 = 3;

// ── cadence: 06:00 and 18:00 UTC ────────────────────────────────────────────
const DEFAULT_CADENCE_MS: u64 = 43_200_000;
const DEFAULT_OFFSET_MS: u64 = 21_600_000;
const MIN_CADENCE_MS: u64 = 60_000;

const DEFAULT_SUBMIT_CUTOFF_MS: u64 = 60_000;
const DEFAULT_REVEAL_GRACE_MS: u64 = 600_000;

/// Governed. See aphotic::clearing's banner for the derivation against the ceilings.
const DEFAULT_MAX_BATCH_SIZE: u64 = 256;
const HARD_MAX_BATCH_SIZE: u64 = 512;

const DIGEST_LEN: u64 = 32;
const SEAL_ID_LEN: u64 = 48;
const SALT_LEN: u64 = 32;

// ── structs ─────────────────────────────────────────────────────────────────

/// Governance for the whole auction. Shared, so `seal_approve` can take it as a read-only
/// argument inside the key server's dry run.
public struct BatchRegistry has key {
    id: UID,
    vault_id: ID,
    cadence_ms: u64,
    offset_ms: u64,
    policy_version: u64,
    max_batch_size: u64,
    submit_cutoff_ms: u64,
    reveal_grace_ms: u64,
    next_batch_id: u64,
    live_batches: u64,
}

/// What lands on chain at submit time. No amount, no side, no price (hard constraint §2.3).
/// `submitter` doubles as the reference to the participant's persistent internal balance,
/// which is why no separate escrow reference — and therefore no size signal — is needed.
public struct SealedOrder has copy, drop, store {
    submitter: address,
    commitment: vector<u8>,
    ct_hash: vector<u8>,
    blob_id: vector<u8>,
    submitted_at_ms: u64,
}

/// The plaintext, which exists on chain only after the batch is SEALED.
public struct Order has copy, drop, store {
    submitter: address,
    is_bid: bool,
    limit_price: u64,
    qty_sats: u64,
    salt: vector<u8>,
}

public struct Batch has key {
    id: UID,
    vault_id: ID,
    batch_id: u64,
    state: u8,
    policy_version: u64,
    opened_at_ms: u64,
    close_ms: u64,
    closed_at_ms: u64,
    max_orders: u64,
    submit_cutoff_ms: u64,
    reveal_grace_ms: u64,
    orders: vector<SealedOrder>,
    revealed: vector<Order>,
    is_revealed: vector<bool>,
    revealed_count: u64,
}

// ── registry ────────────────────────────────────────────────────────────────

public fun create_registry(vault_id: ID, ctx: &mut TxContext): BatchRegistry {
    BatchRegistry {
        id: object::new(ctx),
        vault_id,
        cadence_ms: DEFAULT_CADENCE_MS,
        offset_ms: DEFAULT_OFFSET_MS,
        policy_version: 1,
        max_batch_size: DEFAULT_MAX_BATCH_SIZE,
        submit_cutoff_ms: DEFAULT_SUBMIT_CUTOFF_MS,
        reveal_grace_ms: DEFAULT_REVEAL_GRACE_MS,
        next_batch_id: 0,
        live_batches: 0,
    }
}

public fun share_registry(r: BatchRegistry) {
    transfer::share_object(r);
}

fun assert_registry_admin(r: &BatchRegistry, reg: &CapRegistry, cap: &AdminCap) {
    caps::assert_admin(reg, cap);
    assert!(caps::vault_id(reg) == r.vault_id, EWrongRegistry);
}

public fun set_cadence(
    r: &mut BatchRegistry,
    reg: &CapRegistry,
    cap: &AdminCap,
    cadence_ms: u64,
    offset_ms: u64,
) {
    assert_registry_admin(r, reg, cap);
    assert!(cadence_ms >= MIN_CADENCE_MS, EBadParam);
    assert!(offset_ms < cadence_ms, EBadParam);
    assert!(r.live_batches == 0, EBatchAlreadyLive);
    r.cadence_ms = cadence_ms;
    r.offset_ms = offset_ms;
}

public fun set_max_batch_size(
    r: &mut BatchRegistry,
    reg: &CapRegistry,
    cap: &AdminCap,
    n: u64,
) {
    assert_registry_admin(r, reg, cap);
    assert!(n > 0 && n <= HARD_MAX_BATCH_SIZE, EBadParam);
    r.max_batch_size = n;
}

/// Refused while any batch is live: a bump would orphan every order already encrypted under
/// the old identity, and the failure would be silent (the key server would simply decline).
public fun set_policy_version(
    r: &mut BatchRegistry,
    reg: &CapRegistry,
    cap: &AdminCap,
    version: u64,
) {
    assert_registry_admin(r, reg, cap);
    assert!(r.live_batches == 0, EPolicyBumpWithLiveBatch);
    assert!(version > r.policy_version, EBadParam);
    r.policy_version = version;
}

public fun set_submit_cutoff_ms(
    r: &mut BatchRegistry,
    reg: &CapRegistry,
    cap: &AdminCap,
    ms: u64,
) {
    assert_registry_admin(r, reg, cap);
    assert!(ms < r.cadence_ms, EBadParam);
    r.submit_cutoff_ms = ms;
}

public fun set_reveal_grace_ms(
    r: &mut BatchRegistry,
    reg: &CapRegistry,
    cap: &AdminCap,
    ms: u64,
) {
    assert_registry_admin(r, reg, cap);
    assert!(ms > 0, EBadParam);
    r.reveal_grace_ms = ms;
}

// ── mechanical timing ───────────────────────────────────────────────────────

/// The next `offset_ms + k·cadence_ms` strictly after `now_ms`.
///
/// With cadence 12 h and offset 6 h this is 06:00 / 18:00 UTC, because unix epoch day 0 begins
/// at 00:00 UTC. Saturating arithmetic throughout, so a clock far in the future cannot wrap.
public fun next_boundary(now_ms: u64, cadence_ms: u64, offset_ms: u64): u64 {
    assert!(cadence_ms > 0, EBadParam);
    // ⚠ REFINEMENT of the DESIGN-V2 §4 formula, stated rather than silent. Below `offset_ms`
    // the subtraction saturates to zero and the formula would skip the FIRST boundary
    // (`next_boundary(0, 12h, 6h)` would answer 18:00 instead of 06:00). Real timestamps are
    // ~1.7e12 ms so production never enters that window, but a shared golden-vector twin must
    // agree on every input, not merely on the reachable ones. For every `now_ms >= offset_ms`
    // this returns exactly what the DESIGN-V2 formula returns.
    if (now_ms < offset_ms) return offset_ms;
    let since = oracle::saturating_sub(now_ms, offset_ms);
    let periods = since / cadence_ms;
    oracle::saturating_add(offset_ms, oracle::saturating_mul(periods + 1, cadence_ms))
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/// Permissionless. Liveness is not a privilege (spec §9): anyone may open the window, and the
/// close time is not theirs to choose.
public fun open_batch(r: &mut BatchRegistry, clock: &Clock, ctx: &mut TxContext): Batch {
    assert!(r.live_batches == 0, EBatchAlreadyLive);
    let now = clock.timestamp_ms();
    let close_ms = next_boundary(now, r.cadence_ms, r.offset_ms);
    let batch_id = r.next_batch_id;

    r.next_batch_id = batch_id + 1;
    r.live_batches = 1;

    events::emit_batch_opened(r.vault_id, batch_id, close_ms);

    Batch {
        id: object::new(ctx),
        vault_id: r.vault_id,
        batch_id,
        state: STATE_OPEN,
        policy_version: r.policy_version,
        opened_at_ms: now,
        close_ms,
        closed_at_ms: 0,
        max_orders: r.max_batch_size,
        submit_cutoff_ms: r.submit_cutoff_ms,
        reveal_grace_ms: r.reveal_grace_ms,
        orders: vector[],
        revealed: vector[],
        is_revealed: vector[],
        revealed_count: 0,
    }
}

public fun share_batch(b: Batch) {
    transfer::share_object(b);
}

/// The ONE writer of `state`. Strictly increasing, so no path returns to OPEN (@invariant 3).
fun set_state(b: &mut Batch, next: u8) {
    assert!(next > b.state, ENonMonotonic);
    assert!(next <= STATE_SETTLED, EBadState);
    b.state = next;
}

/// Only a commitment, a ciphertext hash and a Walrus locator. Nothing here says how much, which
/// side, or at what price.
public fun submit_order(
    b: &mut Batch,
    commitment: vector<u8>,
    ct_hash: vector<u8>,
    blob_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(b.state == STATE_OPEN, EBadState);
    assert!(commitment.length() == DIGEST_LEN, EBadDigestLength);
    assert!(ct_hash.length() == DIGEST_LEN, EBadDigestLength);

    let now = clock.timestamp_ms();
    // No submit within `submit_cutoff_ms` of the close, so a submit can never race an early
    // key release caused by key-server skew.
    assert!(now + b.submit_cutoff_ms <= b.close_ms, ESubmitWindowClosed);
    // A full batch REJECTS. It does not close early (@invariant 5).
    assert!(b.orders.length() < b.max_orders, EBatchFull);

    let submitter = ctx.sender();
    b.orders.push_back(SealedOrder {
        submitter,
        commitment,
        ct_hash,
        blob_id,
        submitted_at_ms: now,
    });
    b.revealed.push_back(empty_order());
    b.is_revealed.push_back(false);

    events::emit_order_submitted(b.vault_id, b.batch_id, submitter, ct_hash);
}

/// Permissionless, and refuses before the scheduled instant (@invariant 1). The boundary is
/// `>=`, so a transaction landing in the exact millisecond succeeds.
public fun close_batch(b: &mut Batch, clock: &Clock) {
    assert!(b.state == STATE_OPEN, EBadState);
    let now = clock.timestamp_ms();
    assert!(now >= b.close_ms, ETooEarly);

    b.closed_at_ms = now;
    set_state(b, STATE_SEALED);

    events::emit_batch_closed(b.vault_id, b.batch_id, b.orders.length(), now);
}

/// Publish the plaintext of one order. Permissionless: after the time-lock opens, anyone who
/// can fetch the Seal shares can reveal, which is what removes grief-by-non-revelation.
///
/// The commitment binds the PLAINTEXT, so a submitter cannot decrypt to one order and claim
/// another.
public fun reveal_order(b: &mut Batch, index: u64, order: Order, clock: &Clock) {
    assert!(b.state == STATE_SEALED, EBadState);
    assert!(index < b.orders.length(), EIndexOutOfRange);
    assert!(!*b.is_revealed.borrow(index), EAlreadyRevealed);

    let now = clock.timestamp_ms();
    assert!(now <= b.closed_at_ms + b.reveal_grace_ms, ERevealWindowClosed);

    let sealed = b.orders.borrow(index);
    assert!(order.submitter == sealed.submitter, ESubmitterMismatch);
    assert!(order_commitment(&order) == sealed.commitment, ECommitmentMismatch);
    assert!(order.qty_sats > 0, EBadOrder);
    assert!(order.limit_price > 0, EBadOrder);
    assert!(order.salt.length() == SALT_LEN, EBadOrder);

    *b.revealed.borrow_mut(index) = order;
    *b.is_revealed.borrow_mut(index) = true;
    b.revealed_count = b.revealed_count + 1;
}

/// SEALED → CLEARING. Only once every order is revealed or the reveal window has expired, so a
/// clearing can never start against a half-revealed book.
public(package) fun to_clearing(b: &mut Batch, clock: &Clock) {
    assert!(b.state == STATE_SEALED, EBadState);
    let now = clock.timestamp_ms();
    let all_in = b.revealed_count == b.orders.length();
    assert!(all_in || now > b.closed_at_ms + b.reveal_grace_ms, ERevealWindowOpen);
    set_state(b, STATE_CLEARING);
}

/// CLEARING → SETTLED, and the batch stops being live so governance can move again.
public(package) fun to_settled(b: &mut Batch, r: &mut BatchRegistry) {
    assert!(b.state == STATE_CLEARING, EBadState);
    assert!(b.vault_id == r.vault_id, EVaultMismatch);
    assert!(r.live_batches > 0, EBadState);
    set_state(b, STATE_SETTLED);
    r.live_batches = r.live_batches - 1;
}

// ── orders ──────────────────────────────────────────────────────────────────

fun empty_order(): Order {
    Order { submitter: @0x0, is_bid: false, limit_price: 0, qty_sats: 0, salt: vector[] }
}

public fun new_order(
    submitter: address,
    is_bid: bool,
    limit_price: u64,
    qty_sats: u64,
    salt: vector<u8>,
): Order {
    assert!(salt.length() == SALT_LEN, EBadOrder);
    Order { submitter, is_bid, limit_price, qty_sats, salt }
}

/// `commitment = blake2b256(bcs(Order))` — it binds the PLAINTEXT, not the ciphertext.
public fun order_commitment(o: &Order): vector<u8> {
    hash::blake2b256(&bcs::to_bytes(o))
}

// ── the Seal time-lock policy ───────────────────────────────────────────────

/// Build the 48-byte inner identity. The full IBE identity is `bytes(packageId) ‖ inner`;
/// `seal_approve` receives only what this returns.
///
/// `bcs::to_bytes(&u64)` is LITTLE-ENDIAN, which is exactly what `bcs::peel_u64` reads back.
/// One function owns the encoding on this side so the decoder can never drift from it.
public fun seal_identity(close_ms: u64, policy_version: u64, batch: address): vector<u8> {
    let mut out = bcs::to_bytes(&close_ms);
    out.append(bcs::to_bytes(&policy_version));
    out.append(bcs::to_bytes(&batch));
    out
}

/// The policy. Deny by returning `false`; `seal_approve` turns that into an abort.
///
/// No sender check, deliberately (DESIGN-V2 F2): a batch time-lock must be satisfiable by
/// anyone after T, or reveal stops being permissionless.
public fun check_policy(id: vector<u8>, r: &BatchRegistry, c: &Clock): bool {
    // Guard the peels. A short identity is a denial, not an abort inside the framework.
    if (id.length() < SEAL_ID_LEN) return false;

    let mut prepared: BCS = bcs::new(id);
    let t = prepared.peel_u64();
    let ver = prepared.peel_u64();
    let _batch = prepared.peel_address();
    let leftovers = prepared.into_remainder_bytes();

    // The leftovers check is MANDATORY. Without it the policy accepts identities that were
    // never intended — the exact hole upstream `tle.move` warns about.
    (leftovers.length() == 0) && (ver == r.policy_version) && (c.timestamp_ms() >= t)
}

/// Non-`public` `entry`, side-effect free, one command, first argument a non-empty `Pure`,
/// denial by abort — every constraint the key server's dry run imposes.
entry fun seal_approve(id: vector<u8>, r: &BatchRegistry, c: &Clock) {
    assert!(check_policy(id, r, c), ENoAccess);
}

// ── read surface ────────────────────────────────────────────────────────────

public fun registry_vault_id(r: &BatchRegistry): ID { r.vault_id }

public fun cadence_ms(r: &BatchRegistry): u64 { r.cadence_ms }

public fun offset_ms(r: &BatchRegistry): u64 { r.offset_ms }

public fun policy_version(r: &BatchRegistry): u64 { r.policy_version }

public fun max_batch_size(r: &BatchRegistry): u64 { r.max_batch_size }

public fun registry_submit_cutoff_ms(r: &BatchRegistry): u64 { r.submit_cutoff_ms }

public fun registry_reveal_grace_ms(r: &BatchRegistry): u64 { r.reveal_grace_ms }

public fun next_batch_id(r: &BatchRegistry): u64 { r.next_batch_id }

public fun live_batches(r: &BatchRegistry): u64 { r.live_batches }

public fun batch_vault_id(b: &Batch): ID { b.vault_id }

public fun batch_id(b: &Batch): u64 { b.batch_id }

public fun state(b: &Batch): u8 { b.state }

public fun batch_policy_version(b: &Batch): u64 { b.policy_version }

public fun opened_at_ms(b: &Batch): u64 { b.opened_at_ms }

public fun close_ms(b: &Batch): u64 { b.close_ms }

public fun closed_at_ms(b: &Batch): u64 { b.closed_at_ms }

public fun max_orders(b: &Batch): u64 { b.max_orders }

public fun submit_cutoff_ms(b: &Batch): u64 { b.submit_cutoff_ms }

public fun reveal_grace_ms(b: &Batch): u64 { b.reveal_grace_ms }

public fun order_count(b: &Batch): u64 { b.orders.length() }

public fun revealed_count(b: &Batch): u64 { b.revealed_count }

public fun is_revealed_at(b: &Batch, i: u64): bool {
    assert!(i < b.orders.length(), EIndexOutOfRange);
    *b.is_revealed.borrow(i)
}

public fun sealed_order_at(b: &Batch, i: u64): SealedOrder {
    assert!(i < b.orders.length(), EIndexOutOfRange);
    *b.orders.borrow(i)
}

/// Refuses while the batch is OPEN (@invariant 2). Nothing is stored to reveal at that point,
/// and the assert makes the guarantee structural rather than incidental.
public fun revealed_at(b: &Batch, i: u64): Order {
    assert!(b.state != STATE_OPEN, EBadState);
    assert!(i < b.orders.length(), EIndexOutOfRange);
    assert!(*b.is_revealed.borrow(i), EBadOrder);
    *b.revealed.borrow(i)
}

public fun sealed_submitter(s: &SealedOrder): address { s.submitter }

public fun sealed_commitment(s: &SealedOrder): vector<u8> { s.commitment }

public fun sealed_ct_hash(s: &SealedOrder): vector<u8> { s.ct_hash }

public fun sealed_blob_id(s: &SealedOrder): vector<u8> { s.blob_id }

public fun sealed_submitted_at_ms(s: &SealedOrder): u64 { s.submitted_at_ms }

public fun order_submitter(o: &Order): address { o.submitter }

public fun order_is_bid(o: &Order): bool { o.is_bid }

public fun order_limit_price(o: &Order): u64 { o.limit_price }

public fun order_qty_sats(o: &Order): u64 { o.qty_sats }

public fun order_salt(o: &Order): vector<u8> { o.salt }

public fun state_open(): u8 { STATE_OPEN }

public fun state_sealed(): u8 { STATE_SEALED }

public fun state_clearing(): u8 { STATE_CLEARING }

public fun state_settled(): u8 { STATE_SETTLED }

public fun default_cadence_ms(): u64 { DEFAULT_CADENCE_MS }

public fun default_offset_ms(): u64 { DEFAULT_OFFSET_MS }

public fun default_max_batch_size(): u64 { DEFAULT_MAX_BATCH_SIZE }

public fun hard_max_batch_size(): u64 { HARD_MAX_BATCH_SIZE }

public fun default_submit_cutoff_ms(): u64 { DEFAULT_SUBMIT_CUTOFF_MS }

public fun default_reveal_grace_ms(): u64 { DEFAULT_REVEAL_GRACE_MS }

public fun seal_id_len(): u64 { SEAL_ID_LEN }

public fun salt_len(): u64 { SALT_LEN }

// ── test-only helpers ───────────────────────────────────────────────────────

/// Drives the ONE state writer, so the suite can probe all sixteen ordered pairs without a
/// second assignment path existing in the module.
#[test_only]
public fun set_state_for_testing(b: &mut Batch, next: u8) {
    set_state(b, next);
}

#[test_only]
public fun seal_approve_for_testing(id: vector<u8>, r: &BatchRegistry, c: &Clock) {
    seal_approve(id, r, c)
}

/// Release the live-batch slot without walking the state machine, so a table-driven suite can
/// probe transition pairs without needing a settled batch for each row.
#[test_only]
public fun force_release_for_testing(r: &mut BatchRegistry) {
    if (r.live_batches > 0) r.live_batches = r.live_batches - 1;
}

/// The BIG-ENDIAN encoding of the same identity — the trap DESIGN-V2 F1 records. It must NOT
/// open the policy.
#[test_only]
public fun seal_identity_big_endian_for_testing(
    close_ms: u64,
    policy_version: u64,
    batch: address,
): vector<u8> {
    let mut out = bcs::to_bytes(&close_ms);
    out.reverse();
    let mut v = bcs::to_bytes(&policy_version);
    v.reverse();
    out.append(v);
    out.append(bcs::to_bytes(&batch));
    out
}

#[test_only]
public fun destroy_batch_for_testing(b: Batch) {
    let Batch {
        id,
        vault_id: _,
        batch_id: _,
        state: _,
        policy_version: _,
        opened_at_ms: _,
        close_ms: _,
        closed_at_ms: _,
        max_orders: _,
        submit_cutoff_ms: _,
        reveal_grace_ms: _,
        orders: _,
        revealed: _,
        is_revealed: _,
        revealed_count: _,
    } = b;
    id.delete();
}

#[test_only]
public fun destroy_registry_for_testing(r: BatchRegistry) {
    let BatchRegistry {
        id,
        vault_id: _,
        cadence_ms: _,
        offset_ms: _,
        policy_version: _,
        max_batch_size: _,
        submit_cutoff_ms: _,
        reveal_grace_ms: _,
        next_batch_id: _,
        live_batches: _,
    } = r;
    id.delete();
}
