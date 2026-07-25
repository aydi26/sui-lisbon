// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<PinningExplainer/> — the pinning argument made visible)
// @spec       docs/GOLDEN-RULES.md G2 ("NEVER let the exit destination be a runtime input")
// @rules      G2 G3 G7
// @depends    ./ptb.ts (T3.2) · ./exit.css (T3.2) · ../../lib/format.ts (T0.4)
// @facts      This renders the EXACT argument list ./ptb.ts encodes, so the claim
// @facts        "there is no destination argument" is checkable on screen rather than
// @facts        asserted in prose. `describe*` and `build*` are written as a pair and
// @facts        are covered by ptb.ts @invariant 3.
// @facts      In mock mode nothing is signed, so this preview IS the artefact: it is
// @facts        what the live PTB will contain, byte-for-byte in shape (G6).
// @implements export function CallPreview(props: CallPreviewProps): JSX.Element
// @forbidden  rendering an argument that ptb.ts does not actually encode
// @forbidden  a canonical on-chain id literal — values arrive as props (G7)
// @invariant  1. The absence line is rendered whenever the description carries one.
// @ac         docs/APP.md §7 A4
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { CallDescription } from './ptb';
import { truncateMiddle } from '../../lib/format';

export interface CallPreviewProps {
  readonly call: CallDescription;
  /** Caption above the target, e.g. "The transaction you are about to sign". */
  readonly caption?: string;
}

function short(value: string): string {
  return value.startsWith('0x') && value.length > 26 ? truncateMiddle(value, 10) : value;
}

export function CallPreview({ call, caption }: CallPreviewProps) {
  return (
    <div className="xt-call">
      {caption === undefined ? null : <span className="xt-label">{caption}</span>}

      <code className="xt-call-target">
        {call.target}
        {call.typeArguments.length > 0 ? `<${call.typeArguments.map(short).join(', ')}>` : ''}
      </code>

      <ul className="xt-call-args">
        {call.args.map((arg) => (
          <li className="xt-call-arg" key={arg.name}>
            <span className="xt-call-arg-head">
              <span className="xt-call-arg-name">{arg.name}</span>: {arg.type} = {short(arg.value)}
            </span>
            {arg.note === undefined ? null : <span className="xt-call-arg-note">{arg.note}</span>}
          </li>
        ))}
      </ul>

      {call.returns === undefined ? null : (
        <span className="xt-call-arg-note">returns {short(call.returns)}</span>
      )}

      {call.absence === undefined ? null : <p className="xt-call-absence">{call.absence}</p>}
    </div>
  );
}

export default CallPreview;
