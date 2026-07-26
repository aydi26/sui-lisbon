#!/usr/bin/env bash
# ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
# @task       T0.6 (v2 retarget)
# @phase      0
# @status     DONE
# @spec       CLAUDE.md "THE 10 GOLDEN RULES" (G2 G3 G7 G9) · docs/CONVENTIONS.md §2.6 · §6
# @spec       docs/DESIGN-V2.md §7 (INV-C1) · §10 (the gate rows) · §1 F1 (the Seal LE/BE trap)
# @rules      G3 (no keeper-nameable destination) · G5 (monotonic, mechanical state)
# @rules      G6 (the Seal identity is LITTLE-ENDIAN) · G7 (one implementation; ids as config)
# @rules      G9 (no Note carries an amount) · G10 (edition idioms)
# @depends    scripts/gates.ps1 — this file MUST stay semantically identical to it
# @facts      Gate list (13):
# @facts        g7 g4 g2 ids sdk purity transport notes batchstate keepercap send seal_le todo
# @facts        default = all.
# @facts      Same allowlists, same patterns, same exit contract as gates.ps1.
# @facts      ⚠ THE PRODUCT PIVOTED. gateway.move / router.move / journal.move / the old
# @facts        vault.move are DELETED. The Hashi Move boundary is now `carry.move`.
# @facts      A gate whose TARGET FILE does not exist yet reports SKIP with the reason spelled
# @facts        out, and SKIP is counted separately from PASS — never silently green.
# @facts      CODE vs COMMENT: a match inside a `//`, `#`, `/* */` comment or anywhere in a .md
# @facts        file is a NOTE, not a FAIL — an APHOTIC CONTRACT banner naming the forbidden
# @facts        thing is the gate working, not a violation. Pass --strict for literal behaviour.
# @implements gate_g7 · gate_g4 · gate_g2 · gate_ids · gate_sdk · gate_purity · gate_transport
# @implements gate_notes · gate_batchstate · gate_keepercap · gate_send · gate_seal_le · gate_todo
# @forbidden  crashing when move/, keeper/, sdk/ or app/ does not exist — must report SKIP
# @forbidden  counting SKIP as green anywhere in the summary
# @invariant  1. Exit code is non-zero iff at least one gate is FAIL.
# @invariant  2. `todo` is informational and can never fail the run.
# @invariant  3. Verdicts match gates.ps1 for the same tree.
# @invariant  4. A missing target is SKIP with a stated reason, never PASS.
# @ac         same PASS/FAIL/SKIP verdicts as gates.ps1 on the same tree
# @verify     bash scripts/gates.sh all
# @verify     bash scripts/gates.sh all --strict
# └── END CONTRACT ───────────────────────────────────────────────────────────

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

EXCLUDE_RX='/(node_modules|\.git|dist|build|coverage|\.vite|\.turbo|target|\.hashi_raw|\.hashi_src)/'

RX_MOVE='\.move$'
RX_TS='\.tsx?$'
RX_CODE='\.(move|ts|tsx|js|mjs|cjs)$'
RX_ANYTEXT='\.(move|ts|tsx|js|mjs|cjs|json|toml|lock|md|html|css|ps1|sh|yml|yaml)$|(^|\.)env(\.[A-Za-z0-9_.-]+)?$'

# ── the v2 module map (docs/DESIGN-V2.md) ────────────────────────────────────
CARRY_MOVE='move/sources/carry.move'      # THE Hashi boundary (was gateway.move)
NOTES_MOVE='move/sources/notes.move'
BATCH_MOVE='move/sources/batch.move'
SEND_TS='keeper/src/sui/send.ts'          # THE devInspect-then-send wrapper

# docs/DESIGN-V2.md §7 — the COMPLETE keeper-callable list.
KEEPER_CALLABLE='propose_nav attest_limiter allocate deallocate place_carry_bid cancel_carry_bid settle_step'

STRICT=0
FAIL_COUNT=0
PASS_COUNT=0
SKIP_COUNT=0

# Blank out the comment portion of each line, preserving line numbering.
#   - `//` line/trailing comments, but NOT `://` (URLs)
#   - `/*` and block-comment continuation lines starting with `*`
#   - `#` comments in shell/toml/yaml/env files
#   - markdown is prose end to end
decomment() {
  case "$1" in
    *.md)
      sed 's/.*//' "$1" ;;
    *.ps1 | *.sh | *.toml | *.yml | *.yaml | *.lock | *.env | *.env.*)
      sed -E 's@(^|[^:])//.*@\1@; s@/\*.*@@; s@^[[:space:]]*\*.*@@; s@#.*@@' "$1" ;;
    *)
      sed -E 's@(^|[^:])//.*@\1@; s@/\*.*@@; s@^[[:space:]]*\*.*@@' "$1" ;;
  esac
}

# list_files <name-regex> <root>...
list_files() {
  local nameexpr="$1"; shift
  local root
  for root in "$@"; do
    [ -d "$REPO/$root" ] || continue
    find "$REPO/$root" -type f 2>/dev/null
  done | grep -Ev "$EXCLUDE_RX" | grep -E "$nameexpr" || true
}

roots_present() {
  local root out=""
  for root in "$@"; do
    [ -d "$REPO/$root" ] && out="$out${out:+, }$root"
  done
  printf '%s' "$out"
}

report() {
  printf '[%-4s] %-11s %s\n' "$1" "$2" "$3"
  [ -n "${4:-}" ] && printf '       %s\n' "$4"
  return 0
}

# A gate whose target is absent. Distinct verdict, stated reason, counted separately.
skip_gate() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  report SKIP "$1" "$2" "NOTHING CHECKED — $3"
  return 0
}

pass_gate() { PASS_COUNT=$((PASS_COUNT + 1)); report PASS "$1" "$2" "${3:-}"; return 0; }

fail_gate() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  report FAIL "$1" "$2" "${3:-}"
  printf '%s' "$4" | grep -v '^$' | cut -c1-200 | sed 's/^/    /'
  return 0
}

CODE_HITS=""
NOTE_HITS=""
SCAN_COUNT=0

# scan_files <name-regex> <content-regex> <allow-regex|-> <grep-flags> <root>...
# Appends to CODE_HITS / NOTE_HITS and increments SCAN_COUNT.
scan_files() {
  local nameexpr="$1" rx="$2" allow="$3" gflags="$4"; shift 4
  local f rel all code notes
  for f in $(list_files "$nameexpr" "$@"); do
    SCAN_COUNT=$((SCAN_COUNT + 1))
    rel="${f#"$REPO"/}"
    if [ "$allow" != "-" ] && printf '%s' "$rel" | grep -Eq "$allow"; then continue; fi
    # shellcheck disable=SC2086
    all="$(grep -n $gflags -E "$rx" "$f" 2>/dev/null | sed "s|^|$rel:|")" || true
    [ -z "$all" ] && continue
    if [ "$STRICT" -eq 1 ]; then
      CODE_HITS="$CODE_HITS$all"$'\n'
      continue
    fi
    # shellcheck disable=SC2086
    code="$(decomment "$f" | grep -n $gflags -E "$rx" 2>/dev/null | sed "s|^|$rel:|")" || true
    [ -n "$code" ] && CODE_HITS="$CODE_HITS$code"$'\n'
    # notes = every hit that is not a code hit
    if [ -z "$code" ]; then
      notes="$all"
    else
      notes="$(printf '%s\n' "$all" | grep -vxF "$(printf '%s\n' "$code")" || true)"
    fi
    [ -n "$notes" ] && NOTE_HITS="$NOTE_HITS$notes"$'\n'
  done
}

nonblank() { printf '%s' "$1" | tr -d '[:space:]'; }

# verdict <name> <title> <note> <root>...
verdict() {
  local name="$1" title="$2" note="$3"; shift 3
  local present; present="$(roots_present "$@")"
  if [ -z "$present" ]; then
    skip_gate "$name" "$title" "no scan root present: $(printf '%s, ' "$@" | sed 's/, $//')"
    return 0
  fi
  local scanned="$SCAN_COUNT file(s) under $present"
  [ -n "$note" ] && scanned="$scanned — $note"
  local ncount=0
  if [ -n "$(nonblank "$NOTE_HITS")" ]; then
    ncount="$(printf '%s' "$NOTE_HITS" | grep -c . || true)"
    scanned="$scanned · $ncount comment mention(s), not failing"
  fi
  if [ -n "$(nonblank "$CODE_HITS")" ]; then
    fail_gate "$name" "$title" "$scanned" "$CODE_HITS"
  else
    pass_gate "$name" "$title" "$scanned"
  fi
  [ -n "$(nonblank "$NOTE_HITS")" ] && printf '%s' "$NOTE_HITS" | grep -v '^$' | cut -c1-160 | sed 's/^/    note /'
  return 0
}

reset_scan() { CODE_HITS=""; NOTE_HITS=""; SCAN_COUNT=0; }

# ── Move signature parsing, shared by g2 and keepercap (mirrors gates.ps1) ───
# Prints one line per declaration of `fun <name>`:  <line>\t<parameter list>
# Starting the scan at the function NAME (not at the first `(` on the line) is what keeps
# `public(package) fun allocate(...)` from being read as `(package)`; stopping at the
# MATCHING close paren is what keeps a `: (u64, address)` return type out of the params.
fn_signatures() {
  local file="$1" name="$2"
  decomment "$file" | awk -v NAME="$name" '
    function paramlist(s,   st, i, c, d, out) {
      if (!match(s, "fun[ \t]+" NAME "[ \t]*")) return "\001"
      i = RSTART
      while (i <= length(s) && substr(s, i, 1) != "(") i++
      if (i > length(s)) return "\001"
      d = 0; out = ""
      for (; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "(") { d++; if (d == 1) continue }
        else if (c == ")") { d--; if (d == 0) return out }
        if (d >= 1) out = out c
      }
      return "\001"
    }
    {
      if (collecting == 0 && $0 ~ ("fun[ \t]+" NAME "[ \t]*[(<]")) {
        collecting = 1; startln = NR; buf = substr($0, index($0, "fun"))
      } else if (collecting == 1) {
        buf = buf " " $0
      } else next
      p = paramlist(buf)
      if (p != "\001") { gsub(/[ \t]+/, " ", p); print startln "\t" p; collecting = 0; buf = "" }
      else if (NR - startln > 60) { collecting = 0; buf = "" }
    }
  '
}

# INV-C1 (keepercap): does this parameter list name the `address` TYPE anywhere — bare, in a
# vector, in an Option, behind a reference? Word-bounded, so `&AdapterRegistry` / `venue: ID`
# are not false positives.
params_name_an_address_type() {
  printf '%s' "$1" | grep -Eq '(^|[^A-Za-z0-9_])address([^A-Za-z0-9_]|$)'
}

# G2 (exit_to_bitcoin): strictly BROADER, deliberately. The destination is read from the
# vault's pinned value, so NO parameter may name a destination in any form — including
# `bitcoin_address: vector<u8>`, which the word-bounded test above misses (`_address` is
# one identifier).
params_name_a_destination() {
  printf '%s' "$1" | grep -Eqi 'address|recipient|destination|payout_to|send_to'
}

# ── gates (mirror gates.ps1 exactly) ─────────────────────────────────────────

gate_g7() {
  reset_scan
  local note
  if [ -f "$REPO/$CARRY_MOVE" ]; then
    note="$CARRY_MOVE is the sole exempt file"
  else
    note="⚠ $CARRY_MOVE DOES NOT EXIST YET — nothing is exempt, so any hashi:: reference anywhere fails"
  fi
  scan_files "$RX_MOVE" 'hashi::' "^$CARRY_MOVE\$" '' move/sources
  verdict g7 "Hashi isolation: \`hashi::\` only in $CARRY_MOVE" "$note" move/sources
}

gate_g4() {
  reset_scan
  scan_files "$RX_CODE" 'cetus|clmm' '-' '-i' move/sources keeper/src
  verdict g4 'No Cetus/CLMM under move/sources or keeper/src' '' move/sources keeper/src
}

# Two independent checks — see gates.ps1 Invoke-GateG2.
gate_g2() {
  reset_scan
  scan_files "$RX_MOVE" 'bitcoin_address' "^$CARRY_MOVE\$" '' move/sources
  scan_files "$RX_TS" 'bitcoinAddress' '-' '' keeper/src/execution sdk/src/execution

  # (b) the exit_to_bitcoin signature check — NO exemption, carry.move included.
  local f rel declared=0 line params
  for f in $(list_files "$RX_MOVE" move/sources); do
    rel="${f#"$REPO"/}"
    while IFS=$'\t' read -r line params; do
      [ -z "${line:-}" ] && continue
      declared=$((declared + 1))
      if params_name_a_destination "$params"; then
        CODE_HITS="$CODE_HITS$rel:$line: exit_to_bitcoin takes a destination parameter: ($params)"$'\n'
      fi
    done <<< "$(fn_signatures "$f" exit_to_bitcoin)"
  done

  local note="$CARRY_MOVE exempt from the bitcoin_address scan (it composes hashi::withdraw); the exit_to_bitcoin signature check is NOT exempt"
  if [ "$declared" -eq 0 ]; then
    note="$note · no exit_to_bitcoin declared yet, so the signature check inspected nothing"
  else
    note="$note · $declared exit_to_bitcoin declaration(s) inspected"
  fi
  verdict g2 'No bitcoin-address parameter on any exit path' "$note" move/sources keeper/src/execution sdk/src/execution
}

gate_ids() {
  reset_scan
  local rx='0x5cdaebf264|0xfcea10ca|0x22c0ce66|0xf7152c05|0xd874d241|0x22be4cad|0xfb28c4cb|0x243759|0xabf837|0x31358d|0xf9c0172b'
  # move/Move.lock + Published.toml are GENERATED by the Move package manager and carry
  # upstream published-at ids; the scripts/ verifiers are the tools that PROVE these ids.
  local allow='^keeper/src/config\.ts$|^sdk/src/config\.ts$|^app/src/config\.ts$|(^|/)\.env(\.[A-Za-z0-9_.-]+)?$|^move/Move\.toml$|^move/Move\.lock$|^move/Published\.toml$|^scripts/(verify-onchain\.mjs|gates\.ps1|gates\.sh|verify-all\.ps1)$'
  scan_files "$RX_ANYTEXT" "$rx" "$allow" '' move keeper sdk app scripts
  verdict ids 'Canonical ids only in config.ts / .env* / Move.toml' \
    'docs/ is out of scope by design' move keeper sdk app scripts
}

gate_sdk() {
  reset_scan
  # IMPORT forms only — a prose mention of the package name is not a G7 violation.
  scan_files "$RX_TS" "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]@mysten/hashi" \
    '^keeper/src/hashi/real\.ts$|^sdk/src/hashi/real\.ts$' '' keeper/src sdk/src
  verdict sdk '@mysten/hashi imported only in {keeper,sdk}/src/hashi/real.ts' 'import forms only' keeper/src sdk/src
}

gate_purity() {
  reset_scan
  scan_files "$RX_TS" 'Date\.now[[:space:]]*\(|Math\.random[[:space:]]*\(' '-' '' \
    keeper/src/strategy keeper/src/routing sdk/src
  verdict purity 'No Date.now()/Math.random() in strategy/, routing/ or sdk/' \
    'seeded jitter only' keeper/src/strategy keeper/src/routing sdk/src
}

gate_transport() {
  reset_scan
  scan_files "$RX_TS" 'new[[:space:]]+Sui(Grpc|JsonRpc)?Client[[:space:]]*\(' \
    '^keeper/src/sui/client\.ts$|^sdk/src/sui/client\.ts$|^app/src/lib/suiClient\.ts$' '' keeper/src sdk/src app/src
  verdict transport 'Sui client constructed only in sui/client.ts and lib/suiClient.ts' '' keeper/src sdk/src app/src
}

# ── v2 structural gates ──────────────────────────────────────────────────────

# `struct Note` may declare NOTHING but `id` and `denom_index` — any other field leaks
# order size out of escrow regardless of what is encrypted on top. DESIGN-V2 §10/§11.
gate_notes() {
  local title='`struct Note` declares only id + denom_index (no amount can leak)'
  if [ ! -f "$REPO/$NOTES_MOVE" ]; then
    skip_gate notes "$title" "$NOTES_MOVE does not exist yet (v2 notes module has not landed)"
    return 0
  fi
  local out fields bad found
  out="$(decomment "$REPO/$NOTES_MOVE" | awk -v F="$NOTES_MOVE" '
    st == 0 && /struct[ \t]+Note[ \t]+has/ { found = 1; st = ($0 ~ /\{/) ? 1 : 2; next }
    st == 2 { if ($0 ~ /\{/) st = 1; next }
    st == 1 {
      if ($0 ~ /\}/) { st = 3; next }
      line = $0
      sub(/^[ \t]+/, "", line); sub(/[ \t]+$/, "", line)
      if (line == "") next
      i = index(line, ":")
      if (i < 2) next
      name = substr(line, 1, i - 1); gsub(/[ \t]/, "", name)
      print "FIELD\t" name
      if (name != "id" && name != "denom_index") print "BAD\t" F ":" NR ": " line
    }
    END { if (!found) print "NOSTRUCT" }
  ')"
  if printf '%s' "$out" | grep -q '^NOSTRUCT$'; then
    skip_gate notes "$title" "$NOTES_MOVE exists but declares no \`struct Note\`"
    return 0
  fi
  fields="$(printf '%s\n' "$out" | sed -n 's/^FIELD\t//p' | paste -sd',' - | sed 's/,/, /g')"
  [ -z "$fields" ] && fields='(none)'
  bad="$(printf '%s\n' "$out" | sed -n 's/^BAD\t//p')"
  if [ -n "$(nonblank "$bad")" ]; then
    fail_gate notes "$title" "$NOTES_MOVE · fields found: $fields — a Note field other than id/denom_index leaks size out of escrow" "$bad"
  else
    pass_gate notes "$title" "$NOTES_MOVE · fields found: $fields"
  fi
  return 0
}

# `.state =` only inside set_state / open_batch — the single funnel that makes
# OPEN -> SEALED -> CLEARING -> SETTLED provably monotonic. DESIGN-V2 §10.
gate_batchstate() {
  local title='`.state =` only inside set_state / open_batch (monotonic transitions)'
  if [ ! -f "$REPO/$BATCH_MOVE" ]; then
    skip_gate batchstate "$title" "$BATCH_MOVE does not exist yet (v2 batch module has not landed)"
    return 0
  fi
  local out bad writes
  out="$(decomment "$REPO/$BATCH_MOVE" | awk -v F="$BATCH_MOVE" '
    {
      raw = $0
      if (allow == 0 && pending == 0 && raw ~ /fun[ \t]+(set_state|open_batch)[ \t]*[(<]/) pending = 1
      t = raw; ob = gsub(/\{/, "", t)
      t = raw; cb = gsub(/\}/, "", t)
      wasAllowed = (allow == 1 || pending == 1)
      if (pending == 1 && ob > 0) { allow = 1; pending = 0; depth = ob - cb; if (depth <= 0) allow = 0 }
      else if (allow == 1)        { depth += ob - cb;        if (depth <= 0) allow = 0 }
      if (raw ~ /\.state[ \t]*=[^=]/ || raw ~ /\.state[ \t]*=$/) {
        w++
        if (!wasAllowed) { line = raw; sub(/^[ \t]+/, "", line); print "BAD\t" F ":" NR ": " line }
      }
    }
    END { print "WRITES\t" w + 0 }
  ')"
  writes="$(printf '%s\n' "$out" | sed -n 's/^WRITES\t//p')"
  bad="$(printf '%s\n' "$out" | sed -n 's/^BAD\t//p')"
  local n; n="$(printf '%s' "$bad" | grep -c . || true)"
  if [ -n "$(nonblank "$bad")" ]; then
    fail_gate batchstate "$title" "$BATCH_MOVE · $writes \`.state =\` write(s) total, $n outside set_state/open_batch" "$bad"
  else
    pass_gate batchstate "$title" "$BATCH_MOVE · $writes \`.state =\` write(s) total, 0 outside set_state/open_batch"
  fi
  return 0
}

# INV-C1 (DESIGN-V2 §7): no KeeperCap-gated function may take an `address` parameter.
# The invariant is enforced by the ABSENCE of the parameter, so a grep IS the enforcement.
gate_keepercap() {
  local title='No KeeperCap-gated function takes an address parameter (INV-C1)'
  if [ ! -d "$REPO/move/sources" ]; then
    skip_gate keepercap "$title" 'no scan root present: move/sources'
    return 0
  fi
  local name f rel line params found="" missing="" any bad=""
  for name in $KEEPER_CALLABLE; do
    any=0
    for f in $(list_files "$RX_MOVE" move/sources); do
      rel="${f#"$REPO"/}"
      while IFS=$'\t' read -r line params; do
        [ -z "${line:-}" ] && continue
        any=1
        if params_name_an_address_type "$params"; then
          bad="$bad$rel:$line: $name takes an address parameter: ($params)"$'\n'
        fi
      done <<< "$(fn_signatures "$f" "$name")"
    done
    if [ "$any" -eq 1 ]; then found="$found${found:+, }$name"; else missing="$missing${missing:+, }$name"; fi
  done
  if [ -z "$found" ]; then
    skip_gate keepercap "$title" "none of the 7 keeper-callable functions is declared yet: $(printf '%s' "$KEEPER_CALLABLE" | tr ' ' ',' | sed 's/,/, /g')"
    return 0
  fi
  local note="checked: $found"
  [ -n "$missing" ] && note="$note · NOT YET DECLARED (unchecked): $missing"
  if [ -n "$(nonblank "$bad")" ]; then
    fail_gate keepercap "$title" "$note" "$bad"
  else
    pass_gate keepercap "$title" "$note"
  fi
  return 0
}

# Every transaction goes through the devInspect-then-send wrapper, so a transaction that
# would revert is never broadcast.
gate_send() {
  local title="signAndExecute only in $SEND_TS (devInspect-then-send)"
  if [ ! -f "$REPO/$SEND_TS" ]; then
    skip_gate send "$title" "$SEND_TS does not exist yet, so there is no wrapper to funnel through (v2 keeper has not landed)"
    return 0
  fi
  reset_scan
  scan_files "$RX_TS" 'signAndExecute' "^$SEND_TS\$" '' keeper/src sdk/src
  verdict send "$title" 'a revert must never be broadcast' keeper/src sdk/src
}

# DESIGN-V2 §1 F1 — the deleted vault.move decoded the Seal identity epoch BIG-ENDIAN
# (`epoch = (epoch << 8) + byte`) while `bcs::peel_u64` reads LITTLE-ENDIAN. Copying that
# forward yields a policy that never opens, and it fails SILENTLY.
gate_seal_le() {
  local title="No big-endian u64 decode (\`<< 8\`) in $BATCH_MOVE (Seal identity is LE)"
  if [ ! -f "$REPO/$BATCH_MOVE" ]; then
    skip_gate seal_le "$title" "$BATCH_MOVE does not exist yet (v2 batch module has not landed)"
    return 0
  fi
  local bad
  bad="$(decomment "$REPO/$BATCH_MOVE" | grep -nE '<<[[:space:]]*8([^0-9]|$)' | sed "s|^|$BATCH_MOVE:|" || true)"
  local note="$BATCH_MOVE · use bcs::peel_u64 (LITTLE-ENDIAN); see DESIGN-V2 §1 F1 and §3"
  if [ -n "$(nonblank "$bad")" ]; then
    fail_gate seal_le "$title" "$note" "$bad"
  else
    pass_gate seal_le "$title" "$note"
  fi
  return 0
}

gate_todo() {
  local present; present="$(roots_present move keeper sdk app scripts)"
  if [ -z "$present" ]; then
    skip_gate todo 'TODO(Tx.y) census' 'no scan root present: move, keeper, sdk, app, scripts'
    return 0
  fi
  local files census total ids
  files="$(list_files "$RX_CODE" move keeper sdk app scripts)"
  # shellcheck disable=SC2086
  census="$(printf '%s\n' $files | xargs -r grep -ohE 'TODO\(T[0-9]+\.[0-9]+\)' 2>/dev/null | sort | uniq -c | awk '{printf "    %-14s %s\n", $2, $1}')" || true
  # shellcheck disable=SC2086
  total="$(printf '%s\n' $files | xargs -r grep -ohE 'TODO\(T[0-9]+\.[0-9]+\)' 2>/dev/null | wc -l | tr -d ' ')" || total=0
  ids="$(printf '%s' "$census" | grep -c . || true)"
  report INFO todo 'TODO(Tx.y) census (informational)' \
    "$total marker(s) across $ids task id(s) under $present"
  [ -n "$census" ] && printf '%s\n' "$census"
  return 0
}

# ── dispatch ─────────────────────────────────────────────────────────────────
ALL_GATES="g7 g4 g2 ids sdk purity transport notes batchstate keepercap send seal_le todo"

REQUESTED=""
for arg in "$@"; do
  key="$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]' | sed 's/^-*//')"
  case "$key" in
    strict) STRICT=1 ;;
    all) REQUESTED="$ALL_GATES" ;;
    help | '?')
      echo "gates.sh [$(printf '%s' "$ALL_GATES" | tr ' ' '|')|all] [--strict]   (default: all)"
      echo "  --strict  a match in a comment fails too (literal 'string must not appear')"
      exit 0 ;;
    g7 | g4 | g2 | ids | sdk | purity | transport | notes | batchstate | keepercap | send | seal_le | todo)
      REQUESTED="$REQUESTED $key" ;;
    *) echo "gates.sh: unknown gate '$arg'. Known: $ALL_GATES, all" >&2; exit 2 ;;
  esac
done
[ -z "$(printf '%s' "$REQUESTED" | tr -d ' ')" ] && REQUESTED="$ALL_GATES"

echo ""
echo "Aphotic x Hashi — golden-rule gates"
echo "  repo   : $REPO"
if [ "$STRICT" -eq 1 ]; then
  echo "  mode   : STRICT (comment mentions fail)"
else
  echo "  mode   : default (comment mentions are notes)"
fi
echo ""

for g in $REQUESTED; do
  "gate_$g"
done

echo ""
echo "  $PASS_COUNT PASS · $FAIL_COUNT FAIL · $SKIP_COUNT SKIP"
if [ "$SKIP_COUNT" -gt 0 ]; then
  echo "  (SKIP is NOT green — each one above states what was not checked and why.)"
fi
echo ""

[ "$FAIL_COUNT" -gt 0 ] && exit 1
exit 0
