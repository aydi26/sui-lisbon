#!/usr/bin/env bash
# ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
# @task       T0.6
# @phase      0
# @status     DONE
# @spec       docs/GOLDEN-RULES.md (G2 G4 G5 G7) · docs/CONVENTIONS.md §2.6 · §3
# @rules      G2 G4 G5 G7
# @depends    scripts/gates.ps1 — this file MUST stay semantically identical to it
# @facts      Gate list: g7 g4 g2 ids sdk purity transport todo all   (default = all)
# @facts      Same allowlists, same patterns, same exit contract as gates.ps1.
# @facts      CODE vs COMMENT: a match inside a `//`, `#`, `/* */` comment or anywhere in a .md
# @facts        file is a NOTE, not a FAIL — an APHOTIC CONTRACT banner naming the forbidden
# @facts        thing is the gate working, not a violation. Pass --strict for literal behaviour.
# @implements gate_g7 · gate_g4 · gate_g2 · gate_ids · gate_sdk · gate_purity
# @implements gate_transport · gate_todo
# @forbidden  crashing when move/, keeper/ or app/ does not exist — must report SKIP
# @invariant  1. Exit code is non-zero iff at least one gate is FAIL.
# @invariant  2. `todo` is informational and can never fail the run.
# @invariant  3. Verdicts match gates.ps1 for the same tree.
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
  printf '[%-4s] %-10s %s\n' "$1" "$2" "$3"
  [ -n "${4:-}" ] && printf '       %s\n' "$4"
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
    SKIP_COUNT=$((SKIP_COUNT + 1))
    report SKIP "$name" "$title" "no scan root present: $(printf '%s, ' "$@" | sed 's/, $//')"
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
    FAIL_COUNT=$((FAIL_COUNT + 1))
    report FAIL "$name" "$title" "$scanned"
    printf '%s' "$CODE_HITS" | grep -v '^$' | cut -c1-200 | sed 's/^/    /'
  else
    PASS_COUNT=$((PASS_COUNT + 1))
    report PASS "$name" "$title" "$scanned"
  fi
  [ -n "$(nonblank "$NOTE_HITS")" ] && printf '%s' "$NOTE_HITS" | grep -v '^$' | cut -c1-160 | sed 's/^/    note /'
  return 0
}

reset_scan() { CODE_HITS=""; NOTE_HITS=""; SCAN_COUNT=0; }

# ── gates (mirror gates.ps1 exactly) ─────────────────────────────────────────

gate_g7() {
  reset_scan
  scan_files "$RX_MOVE" 'hashi::' '^move/sources/gateway\.move$' '' move/sources
  verdict g7 'Hashi isolation: `hashi::` only in move/sources/gateway.move' '' move/sources
}

gate_g4() {
  reset_scan
  scan_files "$RX_CODE" 'cetus|clmm' '-' '-i' move/sources keeper/src
  verdict g4 'No Cetus/CLMM under move/sources or keeper/src' '' move/sources keeper/src
}

gate_g2() {
  reset_scan
  scan_files "$RX_MOVE" 'bitcoin_address' '^move/sources/gateway\.move$' '' move/sources
  scan_files "$RX_TS" 'bitcoinAddress' '-' '' keeper/src/execution
  verdict g2 'No bitcoin-address parameter on any exit path' \
    'gateway.move exempt (it composes hashi::withdraw)' move/sources keeper/src/execution
}

gate_ids() {
  reset_scan
  local rx='0x5cdaebf264|0xfcea10ca|0x22c0ce66|0xf7152c05|0xd874d241|0x22be4cad|0xfb28c4cb|0x243759|0xabf837|0x31358d|0xf9c0172b'
  # move/Move.lock + Published.toml are GENERATED by the Move package manager and carry
  # upstream published-at ids; the scripts/ verifiers are the tools that PROVE these ids.
  local allow='^keeper/src/config\.ts$|^app/src/config\.ts$|(^|/)\.env(\.[A-Za-z0-9_.-]+)?$|^move/Move\.toml$|^move/Move\.lock$|^move/Published\.toml$|^scripts/(verify-onchain\.mjs|gates\.ps1|gates\.sh|verify-all\.ps1)$'
  scan_files "$RX_ANYTEXT" "$rx" "$allow" '' move keeper app scripts
  verdict ids 'Canonical ids only in config.ts / .env* / Move.toml' \
    'docs/ is out of scope by design' move keeper app scripts
}

gate_sdk() {
  reset_scan
  # IMPORT forms only — a prose mention of the package name is not a G7 violation.
  scan_files "$RX_TS" "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]@mysten/hashi" \
    '^keeper/src/hashi/real\.ts$' '' keeper/src
  verdict sdk '@mysten/hashi imported only in keeper/src/hashi/real.ts' 'import forms only' keeper/src
}

gate_purity() {
  reset_scan
  scan_files "$RX_TS" 'Date\.now[[:space:]]*\(|Math\.random[[:space:]]*\(' '-' '' \
    keeper/src/strategy keeper/src/routing
  verdict purity 'No Date.now()/Math.random() in strategy/ or routing/' \
    'seeded jitter only' keeper/src/strategy keeper/src/routing
}

gate_transport() {
  reset_scan
  scan_files "$RX_TS" 'new[[:space:]]+Sui(Grpc|JsonRpc)?Client[[:space:]]*\(' \
    '^keeper/src/sui/client\.ts$|^app/src/lib/suiClient\.ts$' '' keeper/src app/src
  verdict transport 'Sui client constructed only in sui/client.ts and lib/suiClient.ts' '' keeper/src app/src
}

gate_todo() {
  local present; present="$(roots_present move keeper app scripts)"
  if [ -z "$present" ]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    report SKIP todo 'TODO(Tx.y) census' 'no scan root present: move, keeper, app, scripts'
    return 0
  fi
  local files census total ids
  files="$(list_files "$RX_CODE" move keeper app scripts)"
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
ALL_GATES="g7 g4 g2 ids sdk purity transport todo"

REQUESTED=""
for arg in "$@"; do
  key="$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]' | sed 's/^-*//')"
  case "$key" in
    strict) STRICT=1 ;;
    all) REQUESTED="$ALL_GATES" ;;
    help | '?')
      echo "gates.sh [g7|g4|g2|ids|sdk|purity|transport|todo|all] [--strict]   (default: all)"
      echo "  --strict  a match in a comment fails too (literal 'string must not appear')"
      exit 0 ;;
    g7 | g4 | g2 | ids | sdk | purity | transport | todo) REQUESTED="$REQUESTED $key" ;;
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
echo ""

[ "$FAIL_COUNT" -gt 0 ] && exit 1
exit 0
