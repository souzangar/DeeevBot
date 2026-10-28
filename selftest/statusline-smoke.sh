#!/usr/bin/env bash
# Smoke + contract test for statusline-quota.sh on THIS machine (it uses
# stat/date/bash features that differ across platforms — this proves the shims
# work here), and a pin of what it renders and mirrors into quota.json:
#   - 5h / 7d / ctx (ctx painted yellow >=60, red >=80, ">200k" marker)
#   - the prompt-cache countdown from the stdin `prompt_cache` object (minutes
#     left, painted by urgency; "cold" once expired; 5m-ttl marker; recent
#     misses with their causes; a low hit ratio), absent when caching was
#     never observed
#   - model tag (yellow when the user settings name another model), effort,
#     fast mode
#   - the per-model weekly FLOOR read from the CLI's own usage cache in
#     ~/.claude.json: "≥NN%" with its age once the reading is stale, "?" past
#     the cached window's reset, a cache stamp that follows rewrites, a
#     60-second ceiling on the cache
#   - the quota.json mirror: model_weekly[], model_pct for the ACTIVE model,
#     cache_* and effort/model/fast/200k keys (the mirror only ever gains keys)
#   - a hostile payload cannot break the single line or smuggle control bytes
# Hermetic: HOME is a scratch dir (no real ~/.claude.json or settings), the
# state dir is a scratch tmpfs stand-in, locale is pinned.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SL="$ROOT/.claude/scripts/statusline-quota.sh"
pass=0; fail=0
ok()  { echo "  ok:   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/statusline-selftest-XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT

proj="$tmp/proj"; mkdir -p "$proj/.claude" "$tmp/xdg" "$tmp/home"
export CLAUDE_PROJECT_DIR="$proj" XDG_RUNTIME_DIR="$tmp/xdg" HOME="$tmp/home" LC_ALL=C
unset CLAUDE_CONFIG_DIR
state="$proj/.claude/state"
q="$state/quota.json"
ESC=$'\033'
now=$(date +%s)

# payload <jq object expr>: $now is bound; the base carries the old fields
P_BASE='{context_window:{used_percentage:33.4},
  rate_limits:{five_hour:{used_percentage:42.7,resets_at:1753600000},
               seven_day:{used_percentage:85.2,resets_at:1753900000}},
  cost:{total_cost_usd:1.25}, session_id:"selftest-session"}'
payload() { jq -c -n --argjson now "$now" "$1"; }
# render <payload>: quota.json is rewritten at most every 10 s, so each render
# that is followed by a mirror assertion starts from a clean slate.
render() { rm -f "$q"; printf '%s' "$1" | "$SL" 2>/dev/null; }
mirror() { jq -e "$1" "$q" >/dev/null 2>&1; }
has()  { printf '%s' "$1" | grep -qF -- "$2"; }
has_re() { printf '%s' "$1" | grep -qE -- "$2"; }
set_mtime() { # FILE EPOCH — touch -t is POSIX; date -d @N is GNU, date -r N is BSD
  local stamp
  stamp=$(TZ=UTC date -d "@$2" +%Y%m%d%H%M.%S 2>/dev/null || TZ=UTC date -r "$2" +%Y%m%d%H%M.%S 2>/dev/null) || return 1
  TZ=UTC touch -t "$stamp" "$1"
}
iso_at() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000000+00:00 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000000+00:00; }

# --- the original contract ----------------------------------------------------
out=$(render "$(payload "$P_BASE")")
case "$out" in *"5h 42%"*)  ok "renders 5h percentage"      ;; *) bad "5h missing: '$out'"  ;; esac
case "$out" in *"85%"*)     ok "renders 7d percentage (colored)" ;; *) bad "7d missing: '$out'" ;; esac
case "$out" in *"ctx 33%"*) ok "renders context percentage" ;; *) bad "ctx missing: '$out'" ;; esac
if [ -f "$q" ] && mirror '.five_hour_pct == 42 and .seven_day_pct == 85 and .session_id == "selftest-session"'; then
  ok "quota.json mirrored through .claude/state"
else bad "quota.json missing or wrong at $q"; fi
[ -f "$state/quota-raw.json" ] && ok "raw payload captured once" || bad "quota-raw.json missing"
if mirror '.model_weekly == [] and .model_pct == -1 and .model_age_s == -1 and .cache_remaining_s == -1 and .effort_level == null and .fast_mode == false and .exceeds_200k == false and .cache_ttl == null'; then
  ok "quota.json carries every additive key at its default when the payload and the usage cache have nothing"
else bad "quota.json default keys wrong: $(cat "$q" 2>/dev/null)"; fi
out=$(printf '' | "$SL" 2>/dev/null)
case "$out" in "ctx ?%"*) ok "empty input → placeholder render" ;; *) bad "empty input: '$out'" ;; esac
out=$(printf '{"rate_limits":{"five_hour":{"used_percentage":"x"}}}' | "$SL" 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "ctx ?% (no rate data yet)" ] && ok "a mistyped payload degrades to the placeholder, exit 0" || bad "mistyped payload: rc=$rc out='$out'"

# --- ctx painting + the >200k marker -------------------------------------------------
out=$(render "$(payload "$P_BASE | .context_window.used_percentage = 85")")
has "$out" "ctx ${ESC}[1;31m85%" && ok "ctx >= 80 is painted red" || bad "ctx 85 not red: '$out'"
out=$(render "$(payload "$P_BASE | .context_window.used_percentage = 65")")
has "$out" "ctx ${ESC}[33m65%" && ok "ctx >= 60 is painted yellow" || bad "ctx 65 not yellow: '$out'"
out=$(render "$(payload "$P_BASE + {exceeds_200k_tokens: true}")")
has "$out" "${ESC}[33m>200k${ESC}[0m" && mirror '.exceeds_200k == true' && ok ">200k marker rendered and mirrored" || bad ">200k marker missing: '$out'"

# --- prompt-cache countdown ------------------------------------------------------------
PC='{warm:true, caching_observed:true, ttl:"1h", expires_at:($now+1500), requests:14, misses:0, hit_ratio:0.91, recache_tokens_if_cold:45000}'
out=$(render "$(payload "$P_BASE + {prompt_cache: $PC}")")
has_re "$out" 'cache (24|25)m→[0-9]{2}:[0-9]{2}' && ok "cache countdown: minutes left and the expiry clock time" || bad "cache countdown missing: '$out'"
has "$out" "5m ttl" && bad "a 1h ttl showed the 5m marker" || ok "a 1h ttl shows no ttl marker"
has "$out" " hit " && bad "a healthy hit ratio is shown" || ok "a healthy hit ratio stays hidden"
if mirror '.cache_ttl == "1h" and .cache_warm == true and .cache_requests == 14 and .cache_misses == 0 and .cache_hit_ratio == 0.91 and .cache_recache_tokens_if_cold == 45000' \
   && mirror ".cache_expires_at == $((now + 1500)) and .cache_remaining_s > 1400 and .cache_remaining_s <= 1500"; then
  ok "quota.json mirrors the cache: ttl, warm, counts, ratio, expiry and seconds remaining"
else bad "cache mirror wrong: $(cat "$q" 2>/dev/null)"; fi
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .expires_at = (\$now + 400))}")")
has_re "$out" "cache ${ESC}\[33m[67]m${ESC}\[0m→" && ok "cache under 10 minutes is painted yellow" || bad "cache 400s not yellow: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .expires_at = (\$now + 120))}")")
has_re "$out" "cache ${ESC}\[1;31m[12]m${ESC}\[0m→" && ok "cache under 3 minutes is painted red" || bad "cache 120s not red: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .expires_at = (\$now + 20))}")")
has_re "$out" "cache ${ESC}\[1;31m<1m${ESC}\[0m→" && ok "cache under a minute reads <1m" || bad "cache 20s: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .expires_at = (\$now - 30))}")")
has "$out" "cache cold" && ! has_re "$out" 'cache [0-9<]' && mirror '.cache_remaining_s < 0' && ok "an expired cache reads 'cache cold' and mirrors a negative remainder" || bad "cold cache: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .caching_observed = false)}")")
has "$out" "cache" && bad "caching never observed still rendered a cache segment" || ok "caching never observed: no cache segment"
out=$(render "$(payload "$P_BASE")")
has "$out" "cache" && bad "no prompt_cache object still rendered a cache segment" || ok "no prompt_cache object: no cache segment"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .ttl = \"5m\")}")")
has "$out" "${ESC}[33m5m ttl${ESC}[0m" && mirror '.cache_ttl == "5m"' && ok "a 5m ttl is flagged yellow (extra usage or a forced ttl)" || bad "5m ttl marker missing: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .misses = 2 | .last_miss_at = (\$now - 120) | .last_miss_cause = {causes: [\"tools_changed\", \"ttl_expired_5m\", \"x_changed\"]})}")")
has "$out" "(miss 2m: tools+expired+1)" && mirror '.cache_last_miss_causes == ["tools_changed", "ttl_expired_5m", "x_changed"]' && ok "a recent miss shows its age and shortened causes (two plus a count of the rest)" || bad "miss display wrong: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .misses = 2 | .last_miss_at = (\$now - 5000))}")")
has "$out" "(miss" && bad "an old miss is still shown" || ok "a miss older than 15 minutes is not shown"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .requests = 10 | .hit_ratio = 0.5)}")")
has "$out" "hit 50%" && ok "a low hit ratio (after 5+ requests) is shown" || bad "low hit ratio hidden: '$out'"
out=$(render "$(payload "$P_BASE + {prompt_cache: ($PC | .expires_at = \"soon\")}")")
has "$out" "cache" && bad "a non-numeric expiry rendered a cache segment" || ok "a non-numeric expires_at is ignored"

# --- model tag, effort, fast mode ------------------------------------------------------------
MODEL='{model: {id: "claude-opus-5-5", display_name: "Opus 5.5"}, effort: {level: "high"}, fast_mode: true}'
out=$(render "$(payload "$P_BASE + $MODEL")")
has "$out" "opus 5.5" && has "$out" "eff high" && has "$out" "${ESC}[33mfast${ESC}[0m" && ok "model tag, effort level and the fast marker are rendered" || bad "model/effort/fast missing: '$out'"
mirror '.effort_level == "high" and .model_id == "claude-opus-5-5" and .model_display == "Opus 5.5" and .fast_mode == true' && ok "quota.json mirrors effort, model id/display and fast mode" || bad "model mirror wrong"
case "$out" in *"opus 5.5"*"eff high") ok "the model and effort are the last segments" ;; *) bad "model/effort not last: '$out'" ;; esac
mkdir -p "$HOME/.claude"
printf '{"model":"sonnet"}' > "$HOME/.claude/settings.json"
out=$(render "$(payload "$P_BASE + $MODEL")")
has "$out" "${ESC}[33mopus 5.5${ESC}[0m" && ok "the model tag turns yellow when the user settings name another model" || bad "mismatch not yellow: '$out'"
printf '{"model":"opus"}' > "$HOME/.claude/settings.json"
out=$(render "$(payload "$P_BASE + $MODEL")")
has "$out" "${ESC}[33mopus 5.5" && bad "an alias that matches the active id was painted as a mismatch" || ok "an alias (opus) matches its id (claude-opus-5-5): no warning"
printf '{"model":"claude-opus-5-5[1m]"}' > "$HOME/.claude/settings.json"
out=$(render "$(payload "$P_BASE + $MODEL")")
has "$out" "${ESC}[33mopus 5.5" && bad "a full id with a suffix was painted as a mismatch" || ok "a full id with a context suffix matches too"
rm -f "$HOME/.claude/settings.json"
out=$(render "$(payload "$P_BASE + $MODEL")")
has "$out" "${ESC}[33mopus 5.5" && bad "unreadable settings painted a warning" || ok "no readable user settings: nothing painted"
out=$(render "$(payload "$P_BASE + {model: {id: \"m1\"}}")")
has "$out" "m1" && ok "a model with no display name falls back to its id" || bad "id fallback missing: '$out'"
out=$(render "$(payload "$P_BASE")")
has "$out" "eff " && bad "an absent effort object rendered an effort" || ok "no effort object: no effort segment"

# --- a hostile payload cannot break the line or smuggle control bytes --------------------------
HOSTILE='{model: {id: "m2", display_name: "Evil\nName\u001b[31mred"}, effort: {level: "hi\nX"}, prompt_cache: {caching_observed: true, ttl: "1h\nforged", expires_at: ($now + 900), last_miss_at: ($now - 10), misses: 3, last_miss_cause: {causes: ["a\nb"]}}}'
out=$(render "$(payload "$P_BASE + $HOSTILE")")
nl=$(printf '%s' "$out" | wc -l | tr -d ' ')
[ "$nl" -eq 0 ] && ok "a hostile payload still renders ONE line" || bad "hostile payload broke the line ($nl newlines)"
has "$out" "${ESC}[31mred" && bad "a payload string smuggled an escape sequence" || ok "payload strings lose their control characters (no raw escape from the payload)"
mirror '(.model_display | type) == "string"' && ok "the mirror survives a hostile payload" || bad "mirror broken by a hostile payload"

# --- the per-model weekly floor -----------------------------------------------------------------
cfg="$HOME/.claude.json"
mkcfg() { # <name> <percent> <fetched seconds ago> <reset epoch>
  jq -n --arg n "$1" --argjson p "$2" --argjson ago "$3" --arg r "$(iso_at "$4")" --argjson now "$now" '
    {cachedUsageUtilization: {accountUuid: "x", fetchedAtMs: (($now - $ago) * 1000),
       utilization: {limits: [
         {kind: "session", percent: 13, resets_at: $r, scope: null},
         {kind: "weekly_all", percent: 31, resets_at: $r, scope: null},
         {kind: "weekly_scoped", percent: $p, resets_at: $r, scope: {model: {id: null, display_name: $n}, surface: null}}]}}}' > "$cfg"
}
FUTURE=$((now + 3 * 86400))
mkcfg Fable 52 7200 "$FUTURE"
out=$(render "$(payload "$P_BASE + {model: {id: \"claude-fable-5\", display_name: \"Fable 5.1\"}}")")
has_re "$out" 'fable ≥52%→[A-Z][a-z]{2} [0-9]{2}' && has "$out" "(2h)" && ok "a stale per-model reading renders as a floor: ≥NN% with its reset date and age" || bad "weekly floor missing: '$out'"
if mirror '(.model_weekly | length) == 1 and .model_weekly[0].name == "Fable" and .model_weekly[0].pct == 52' \
   && mirror ".model_weekly[0].resets_at_epoch == $FUTURE and .model_weekly[0].fetched_at == $((now - 7200))"; then
  ok "quota.json mirrors model_weekly[] (name, pct, ISO and epoch reset, fetch time)"
else bad "model_weekly mirror wrong: $(jq -c .model_weekly "$q" 2>/dev/null)"; fi
mirror '.model_pct == 52 and .model_name == "Fable" and .model_age_s >= 7200 and .model_age_s < 7300' && ok "model_pct/model_name/model_age_s describe the row matching the ACTIVE model" || bad "active-model keys wrong: $(jq -c '[.model_pct,.model_name,.model_age_s]' "$q" 2>/dev/null)"
out=$(render "$(payload "$P_BASE + {model: {id: \"claude-opus-5\", display_name: \"Opus 5\"}}")")
mirror '.model_pct == -1 and .model_name == null and .model_age_s == -1 and (.model_weekly | length) == 1' && ok "another active model matches no weekly row: model_pct -1 (the rows stay mirrored)" || bad "non-matching model keys wrong"
out=$(render "$(payload "$P_BASE")")
mirror '.model_pct == -1' && ok "no model in the payload: model_pct -1" || bad "model-less payload keys wrong"
mkcfg Fable 52 60 "$FUTURE"
out=$(render "$(payload "$P_BASE")")
has_re "$out" 'fable 52%→' && ! has "$out" "≥" && ! has "$out" "(1m)" && ok "a fresh per-model reading (under 15 minutes) carries no floor marker or age" || bad "fresh reading rendered as stale: '$out'"
mkcfg Fable 52 7200 "$((now - 60))"
out=$(render "$(payload "$P_BASE")")
has "$out" "fable ?%" && has "$out" "(reset)" && ! has "$out" "52%" && ok "past the cached window's reset the number is withheld: fable ?% (reset)" || bad "expired window not withheld: '$out'"
mkcfg "Sonnet 5.5" 71 7200 "$FUTURE"
out=$(render "$(payload "$P_BASE")")
has "$out" "sonnet 5.5 ≥${ESC}[33m71%" && ok "a model name with spaces renders whole; a 71% floor is painted yellow" || bad "spaced model name wrong: '$out'"
rm -f "$cfg"
out=$(render "$(payload "$P_BASE")")
has "$out" "≥" && bad "no usage cache still rendered a floor" || ok "no ~/.claude.json: no per-model segment"
mirror '.model_weekly == []' && ok "no usage cache: model_weekly is []" || bad "model_weekly not [] without a cache"
printf 'this is not json' > "$cfg"
out=$(render "$(payload "$P_BASE")"); rc=$?
has "$out" "5h 42%" && mirror '.model_weekly == []' && ok "an unreadable ~/.claude.json costs the segment only" || bad "bad config broke the render: '$out'"
rm -f "$cfg"

# the cache stamp follows rewrites; the cache is re-read at least once a minute
mkcfg Fable 52 7200 "$FUTURE"
out=$(render "$(payload "$P_BASE")")
first=$(head -n 1 "$state/model-weekly.tsv" 2>/dev/null)
echo "$first" | grep -qE '^[0-9]+(\.[0-9]+)?:[0-9]+$' && ok "the weekly cache stamp is mtime (sub-second where stat has it) plus size" || bad "cache stamp shape wrong: '$first'"
mkcfg Fable 53 7200 "$FUTURE"; printf ' ' >> "$cfg"   # a rewrite inside the same second, one byte longer
out=$(render "$(payload "$P_BASE")")
has "$out" "fable ≥53%" && ok "a rewrite of ~/.claude.json inside the same second is picked up" || bad "same-second rewrite served stale: '$out'"
cp -p "$cfg" "$tmp/cfg.orig"; mkcfg Fable 54 7200 "$FUTURE"; printf ' ' >> "$cfg"; touch -r "$tmp/cfg.orig" "$cfg"   # same size, same mtime: the stamp cannot tell
out=$(render "$(payload "$P_BASE")")
has "$out" "fable ≥53%" && ok "(documented limit) a rewrite the stamp cannot see is served from the cache ..." || bad "unexpected re-read: '$out'"
set_mtime "$state/model-weekly.tsv" $((now - 120))
out=$(render "$(payload "$P_BASE")")
has "$out" "fable ≥54%" && ok "... until the 60-second ceiling re-reads it" || bad "60 s ceiling did not re-read: '$out'"
rm -f "$cfg"

# CLAUDE_CONFIG_DIR relocates both the usage cache and the user settings
cdir="$tmp/cfgdir"; mkdir -p "$cdir"
( cfg="$cdir/.claude.json"; mkcfg Fable 61 7200 "$FUTURE" )
printf '{"model":"sonnet"}' > "$cdir/settings.json"
rm -f "$q"; out=$(printf '%s' "$(payload "$P_BASE + $MODEL")" | CLAUDE_CONFIG_DIR="$cdir" "$SL" 2>/dev/null)
has "$out" "fable ≥${ESC}[33m61%" && ok "CLAUDE_CONFIG_DIR: the usage cache is read from \$CLAUDE_CONFIG_DIR/.claude.json" || bad "CLAUDE_CONFIG_DIR usage cache ignored: '$out'"
has "$out" "${ESC}[33mopus 5.5${ESC}[0m" && ok "CLAUDE_CONFIG_DIR: the user settings are read from \$CLAUDE_CONFIG_DIR/settings.json" || bad "CLAUDE_CONFIG_DIR settings ignored: '$out'"

echo "statusline-smoke: $pass ok, $fail failed"
[ "$fail" -eq 0 ]
