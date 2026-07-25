// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.2 (verification affordance — the panel wraps the CLI)
// @spec       docs/KEEPER.md §9.1 (decision replay: re-run evaluate/route against
//             the RECORDED inputs and report anything that fails to reproduce)
// @rules      G5 G8
// @depends    ../../components/BridgeColumn.tsx (T5.2 — owns the keeper transport)
//             ../../fixtures (T0.4) · ../../config.ts (T0.4)
// @facts      Equivalent CLI: `npx ts-node src/index.ts verify --vault <VAULT_ID>
// @facts        --from-epoch <N> --bridge-replay`.
// @facts      keeper/src/verify/ is T4.3 and is NOT built yet, so this endpoint is
// @facts        expected to be unreachable during the hackathon build. Reporting
// @facts        that verbatim IS the correct behaviour — never fabricate a pass.
// @facts      TWO-TIER HONESTY (docs/KEEPER.md §9.1): *routing* correctness given
// @facts        the recorded book is publicly checkable with no keys; *trigger*
// @facts        correctness needs the strategy plaintext (owner, or a Seal
// @facts        version-epoch scoped disclosure). Say which tier a result covers.
// @implements export type DecisionReplay
//             export async function rerunDecision(record, signal?): Promise<DecisionReplay>
//             export function describeVerifyFailure(err): string
//             export function equivalentCli(): string
// @forbidden  reporting a decision as reproduced when the verifier did not run
// @forbidden  a canonical id literal here — G7
// @invariant  1. Nothing here runs on mount; it is user-initiated only (G6/A11).
// @invariant  2. An unreachable keeper surfaces as a failure, not as a pass.
// @ac         docs/APP.md §7 A7
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import {
  KeeperVerifyError,
  keeperVerifyEndpoint,
  postKeeperVerify,
} from '../../components/BridgeColumn';
import { config } from '../../config';
import type { DecisionRecord } from '../../fixtures';

const REPLAY_DECISION_PATH = '/replay-decision';

/** Which tier of the replay a result covers — docs/KEEPER.md §9.1. */
export type ReplayTier = 'routing' | 'trigger';

export interface DecisionReplay {
  readonly seq: number;
  readonly reproduced: boolean;
  /** What the verifier recomputed, when it answered. */
  readonly recomputed?: string;
  /** Fields that did not reproduce. Empty on a clean replay. */
  readonly mismatches: readonly string[];
  readonly tier: ReplayTier;
  readonly endpoint: string;
  readonly durationMs: number;
}

interface RawDecisionReplay {
  reproduced?: boolean;
  decision?: string;
  mismatches?: string[];
  tier?: string;
}

/**
 * Ask the keeper `verify/` service to re-run one decision against its own
 * recorded inputs. Always a live call — the point of the affordance is that it
 * either reaches a real verifier or says, out loud, that it could not.
 */
export async function rerunDecision(
  record: DecisionRecord,
  signal?: AbortSignal,
): Promise<DecisionReplay> {
  const startedAt = Date.now();
  const raw = await postKeeperVerify<RawDecisionReplay>(
    REPLAY_DECISION_PATH,
    { vaultId: config.aphotic.vaultId, seq: record.seq, strategyBlobId: record.strategyBlobId },
    signal,
  );

  return {
    seq: record.seq,
    reproduced: raw.reproduced === true,
    ...(raw.decision !== undefined ? { recomputed: raw.decision } : {}),
    mismatches: raw.mismatches ?? [],
    tier: raw.tier === 'trigger' ? 'trigger' : 'routing',
    endpoint: keeperVerifyEndpoint(REPLAY_DECISION_PATH),
    durationMs: Date.now() - startedAt,
  };
}

/** Human-readable, verbatim failure text for the UI. Never softened. */
export function describeVerifyFailure(err: unknown): string {
  if (err instanceof KeeperVerifyError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The CLI a reviewer can run instead of trusting this button. */
export function equivalentCli(): string {
  const vault = config.aphotic.vaultId === '' ? '<VAULT_ID>' : config.aphotic.vaultId;
  return `npx ts-node src/index.ts verify --vault ${vault} --from-epoch 0 --bridge-replay`;
}
