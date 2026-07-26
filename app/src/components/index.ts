// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §5 (app/), docs/CONVENTIONS.md §2 rule 6
// @rules      G7
// @depends    ./*.tsx (F1)
// @facts      Screens import from '../../components', never from a component file
// @facts        directly — one barrel keeps the id-grep surface small.
// @implements re-exports of every shared component
// @forbidden  a canonical on-chain id anywhere under components/ — G7
// @ac         `rg '0x[a-f0-9]{16,}' src/components` returns nothing.
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

export { AddressPill } from './AddressPill';
export type { AddressPillProps } from './AddressPill';

export { DenominationLadder, DENOMINATIONS } from './DenominationLadder';
export type { Denomination, DenominationLadderProps } from './DenominationLadder';

export { EpochClock, epochClockState } from './EpochClock';
export type { EpochClockProps, EpochClockState, EpochPhase } from './EpochClock';

export { KeeperCapabilityBadge } from './KeeperCapabilityBadge';

export { LifecycleStepper } from './LifecycleStepper';
export type { LifecycleStage, LifecycleStepperProps, TimeClass } from './LifecycleStepper';

export { LimitationsPanel, LIMITATIONS } from './LimitationsPanel';
export type { Limitation, LimitationsPanelProps } from './LimitationsPanel';

export { PendingCall } from './PendingCall';
export type { PendingCallProps } from './PendingCall';

export { PinningExplainer } from './PinningExplainer';

export { StaleBanner } from './StaleBanner';
export type { BreakerReason, StaleBannerProps } from './StaleBanner';


export { WalletBar } from './WalletBar';
export type { WalletBarProps } from './WalletBar';

export { ZkLoginButton, EnokiSetupPanel, SponsorshipNote } from './ZkLoginButton';
export type { ZkLoginButtonProps, EnokiSetupPanelProps } from './ZkLoginButton';

export { WalletGate } from './WalletGate';
export type { WalletGateProps } from './WalletGate';
