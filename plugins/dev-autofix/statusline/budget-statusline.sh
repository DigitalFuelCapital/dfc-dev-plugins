#!/usr/bin/env bash
# Budget-aware status line for Claude Code.
#
# Renders two lines:
#   ▮▮▮▮▮▯▯▯▯▯▯▯ 38%/200k │ 12m │ $2.41 │ 91% cached
#   5h 23%~2h14m  wk 61%~3d4h
#
# Side effect, and the reason this script matters to the dev-autofix plugin: every
# refresh hands its input to usage-snapshot.mjs (installed alongside this file),
# which writes the budget snapshot /dev-autofix:run reads. Without it the snapshot
# is never written and /dev-autofix:run refuses to run.
#
# Requires: node. No network calls.
#
# Install: see statusline/README.md
#
# rate_limits is only present for Claude subscription plans, and only after the
# first API response of a session. When absent, the budget line is omitted and
# no snapshot is written -- that is expected, not an error.

set -uo pipefail

input=$(cat)

# Persist the budget snapshot. Separate script so any status line can reuse it.
printf '%s' "$input" | node "$(dirname "$0")/usage-snapshot.mjs" 2>/dev/null

# ── Responsive width ──────────────────────────────────────────
COLS=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
if   (( COLS < 40 )); then BAR_W=6
elif (( COLS < 60 )); then BAR_W=8
elif (( COLS < 90 )); then BAR_W=12
else                       BAR_W=16; fi

# ── Colors (24-bit RGB, Tailwind palette) ─────────────────────
c() { printf '\033[38;2;%d;%d;%dm' "$1" "$2" "$3"; }
SLATE4=$(c 148 163 184); SLATE5=$(c 100 116 139); SLATE6=$(c 71 85 105)
INDIGO4=$(c 129 140 248); EMERALD4=$(c 52 211 153)
AMBER4=$(c 251 191 36);   ROSE4=$(c 251 113 133)
R='\033[0m'
PIPE="${SLATE5} │ ${R}"

# ── Parse the hook JSON ───────────────────────────────────────
# Node rather than jq: it is already a Claude Code dependency and it works
# identically on Windows.
#
# used_percentage is documented as 0-100 and resets_at as epoch seconds.
# Milliseconds are still accepted, since that guess is unambiguous above 1e12.
_parsed=$(printf '%s\n' "$input" | node -e "
  let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const j = JSON.parse(d);
      const g = (p, fb) => p.split('.').reduce((o, k) => o && o[k], j) ?? fb;

      // epoch: accept seconds or milliseconds, emit seconds
      const ep = s => (s && s > 1e12) ? Math.floor(s / 1000) : s;
      const pct = w => (w && typeof w.used_percentage === 'number')
        ? Math.round(w.used_percentage)
        : '';

      const rl = g('rate_limits', null);
      const pairs = [
        ['PCT',        Math.floor(g('context_window.used_percentage', 0) || 0)],
        ['TOTAL_TOK',  g('context_window.context_window_size', 0) || g('context_window.total_tokens', 200000)],
        ['CACHE_READ', g('context_window.current_usage.cache_read_input_tokens', 0)],
        ['INPUT_TOK',  g('context_window.current_usage.input_tokens', 0)],
        ['CACHE_CRE',  g('context_window.current_usage.cache_creation_input_tokens', 0)],
        ['COST',       g('cost.total_cost_usd', 0)],
        ['DUR_MS',     g('cost.total_duration_ms', 0)],
        ['RL5_PCT',    pct(rl && rl.five_hour)],
        ['RL5_RESET',  ep(rl && rl.five_hour && rl.five_hour.resets_at) || ''],
        ['RL7_PCT',    pct(rl && rl.seven_day)],
        ['RL7_RESET',  ep(rl && rl.seven_day && rl.seven_day.resets_at) || ''],
        ['RLS_PCT',    pct(rl && rl.spend_limit)],
      ];

      const q = s => \"'\" + String(s).replace(/'/g, \"'\\\"'\\\"'\") + \"'\";
      console.log(pairs.map(([k, v]) => k + '=' + q(v)).join(' '));
    } catch (e) { process.exit(1); }
  });
" 2>/dev/null)

# Test the captured output, not eval's exit code: `eval ""` succeeds, so an
# `eval ... || fallback` would silently continue into `set -u` and crash.
if [[ -z $_parsed ]]; then
  printf 'autofix statusline: could not parse hook JSON\n'
  exit 0
fi
eval "$_parsed"

# ── Helpers ───────────────────────────────────────────────────
fmt_dur() {
  local s=$(( ${1:-0} / 1000 ))
  if   (( s < 60 ));   then printf '%ds' "$s"
  elif (( s < 3600 )); then printf '%dm' $(( s / 60 ))
  else printf '%d.%dh' $(( s / 3600 )) $(( (s % 3600) * 10 / 3600 )); fi
}

fmt_tok() {
  local t=${1:-0}
  if   (( t >= 1000000 )); then printf '%d.%dM' $(( t / 1000000 )) $(( t % 1000000 / 100000 ))
  elif (( t >= 1000 ));    then printf '%dk' $(( t / 1000 ))
  else                          printf '%d' "$t"; fi
}

# Time until a reset, as a compact duration
fmt_reset() {
  local s=$(( $1 - $(date +%s) )); (( s < 0 )) && s=0
  if   (( s >= 86400 )); then printf '%dd%dh'  $(( s / 86400 )) $(( s % 86400 / 3600 ))
  elif (( s >= 3600 ));  then printf '%dh%02dm' $(( s / 3600 ))  $(( s % 3600 / 60 ))
  else                        printf '%dm'      $(( s / 60 )); fi
}

# Budget colour: green under 60% used, amber to 85%, rose above
rl_color() {
  if   (( $1 < 60 )); then printf '%s' "$EMERALD4"
  elif (( $1 < 85 )); then printf '%s' "$AMBER4"
  else                     printf '%s' "$ROSE4"; fi
}

# ── Context bar ───────────────────────────────────────────────
FILLED=$(( PCT * BAR_W / 100 ))
# Integer floor makes 1-6% look identical to 0%; clamp so any usage shows.
(( PCT > 0 && FILLED == 0 )) && FILLED=1

BAR=""
for (( i = 0; i < FILLED; i++ )); do
  p=$(( i * 100 / BAR_W ))
  if   (( p < 50 )); then BAR+="${EMERALD4}▮"
  elif (( p < 75 )); then BAR+="${AMBER4}▮"
  else                    BAR+="${ROSE4}▮"; fi
done
for (( i = FILLED; i < BAR_W; i++ )); do BAR+="${SLATE6}▯"; done
BAR+="$R"

# Cache hit rate over input-side tokens
_in=$(( CACHE_READ + INPUT_TOK + CACHE_CRE ))
(( _in > 0 )) && CACHE_PCT=$(( CACHE_READ * 100 / _in )) || CACHE_PCT=0

# ── Render ────────────────────────────────────────────────────
line1="${BAR} ${INDIGO4}${PCT}%${R}/${SLATE4}$(fmt_tok "$TOTAL_TOK")${R}"
line1+="${PIPE}${SLATE4}$(fmt_dur "$DUR_MS")${R}"
line1+="${PIPE}${EMERALD4}$(printf '$%.2f' "$COST")${R}"
(( CACHE_PCT > 0 )) && line1+="${PIPE}${EMERALD4}${CACHE_PCT}%${R} ${SLATE4}cached${R}"
printf '%b\n' "$line1"

# Budget line, omitted entirely when the plan exposes no rate limits
if [[ -n ${RL5_PCT:-} ]]; then
  line2="${INDIGO4}5h${R} $(rl_color "$RL5_PCT")${RL5_PCT}%${R}"
  [[ -n ${RL5_RESET:-} ]] && line2+="${SLATE4}~$(fmt_reset "$RL5_RESET")${R}"
  if [[ -n ${RL7_PCT:-} ]]; then
    line2+="  ${INDIGO4}wk${R} $(rl_color "$RL7_PCT")${RL7_PCT}%${R}"
    [[ -n ${RL7_RESET:-} ]] && line2+="${SLATE4}~$(fmt_reset "$RL7_RESET")${R}"
  fi
  [[ -n ${RLS_PCT:-} ]] && line2+="  ${INDIGO4}spend${R} $(rl_color "$RLS_PCT")${RLS_PCT}%${R}"
  printf '%b\n' "$line2"
fi
