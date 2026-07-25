// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §1 (components/ = shared UI)
// @rules      G7
// @depends    ./*.tsx (T0.4)
// @facts      Screens import from '../../components', never from a component file
// @facts        directly — one barrel keeps the A10 grep surface small.
// @implements re-exports of every shared component
// @forbidden  a canonical on-chain id anywhere under components/ — G7 / A10
// @ac         docs/APP.md §7 A10
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

export { AddressPill } from './AddressPill';
export type { AddressPillProps } from './AddressPill';

export { BridgeColumn, rederiveCongestion } from './BridgeColumn';
export type { BridgeColumnProps } from './BridgeColumn';

export { KeeperCapabilityBadge } from './KeeperCapabilityBadge';

export { LifecycleStepper } from './LifecycleStepper';
export type { LifecycleStepperProps } from './LifecycleStepper';

export { PinningExplainer } from './PinningExplainer';

export { QrCode } from './QrCode';
export type { QrCodeProps } from './QrCode';

export { StaleBanner } from './StaleBanner';
export type { BreakerReason, StaleBannerProps } from './StaleBanner';

export { TrustModelDisclosure, TRUST_MODEL_LINE } from './TrustModelDisclosure';
export type { TrustModelDisclosureProps } from './TrustModelDisclosure';

export { WalletBar } from './WalletBar';
export type { WalletBarProps } from './WalletBar';

export { ZkLoginButton, EnokiSetupPanel, SponsorshipNote } from './ZkLoginButton';
export type { ZkLoginButtonProps, EnokiSetupPanelProps } from './ZkLoginButton';
