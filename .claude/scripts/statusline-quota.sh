#!/usr/bin/env bash
# .claude/scripts/statusline-quota.sh — status line + quota bridge.
#
# Claude Code invokes this with a JSON payload on stdin for every status-line
# render (wired per-user via "statusLine" in .claude/settings.local.json). The
# account rate-limit budget (5h/7d used% + reset epochs, Pro/Max only) is
# exposed ONLY on this stdin, so besides rendering the one-line status we
# mirror the numbers to .claude/state/quota.json (keep .claude/state
# gitignored — INSTALL step 1 appends the rule to the repo's .gitignore)
# where both the user and the model can read them
# mid-session — e.g. between units of a long autonomous run:
#   jq . .claude/state/quota.json
# quota-raw.json keeps the first raw payload seen (delete it to re-capture).
# The raw payload and quota.json contain session ids and usage percentages —
# local telemetry, no secrets, but keep them out of version control.
#
# Besides rate_limits and context_window (ctx), the payload carries, and this
# script renders and mirrors: prompt_cache (the main conversation's prompt
# cache: ttl, expires_at, requests, misses, hit_ratio, the last miss and its
# causes; present only after the first main-thread request; Claude Code
# 2.1.251+), effort.level (only for a model that supports effort), model (id,
# display_name), fast_mode and exceeds_200k_tokens. The mirror only ever
# gains keys: hooks and memory notes read named keys, so none is renamed or
# retyped.
#
# The per-model weekly window — the "Current week (<model>)" limit that /usage
# shows, and the one a heavy use of one model spends — is NOT on that stdin:
# rate_limits carries five_hour, seven_day and (gateway only) spend_limit,
# nothing else. It is read instead from the CLI's own cache in ~/.claude.json
# (cachedUsageUtilization), which is refreshed only when the CLI last called
# /api/oauth/usage — in practice when /usage was opened, so it can be hours
# stale. Usage only rises inside one weekly window, so a stale reading is a
# FLOOR: it renders as "≥NN%" followed by its age. Once the cached window's
# own reset time has passed the number means nothing and it renders "?" —
# open /usage to refresh it. quota.json mirrors every row as model_weekly[]
# (name, pct, resets_at, resets_at_epoch, fetched_at) and, for the row that
# matches the ACTIVE model, as model_pct / model_name / model_resets_at /
# model_fetched_at / model_age_s (-1 = no matching reading).
#
# The cache countdown is prompt_cache.expires_at - now: expires_at already
# counts keep-alive touches, while the payload's own `warm` was computed when
# the payload was built. Renders are event-driven (a new message, a mode
# change) and go quiet while the session idles, so a TICKING countdown needs
# "refreshInterval" (seconds, e.g. 30) on the per-user "statusLine" in
# .claude/settings.local.json; without it the number is as of the last
# render. Claude Code does re-run the line once, 1 s after the cache expires,
# so warm→cold shows on time even without the timer.
#
# The physical bytes live on tmpfs (RAM, $XDG_RUNTIME_DIR) behind a
# .claude/state symlink, so the recurring writes never touch flash; the state
# is ephemeral by design (stale after minutes), so losing it on reboot is
# free — the script re-creates and re-points on the next render. The tmpfs
# dir is keyed by project basename + a checksum of the full path, so two
# repos with the same basename never share state. Plain on-disk dir only as
# a fallback when no runtime dir exists.
#
# Portability: works on GNU and BSD/macOS userlands (stat/date fallbacks
# below); requires jq; bash 3.2+ (no mapfile/associative arrays).
#
# Defensive by design: never fails the render — prints whatever it has.

input=$(cat 2>/dev/null || true)

proj="${CLAUDE_PROJECT_DIR:-$PWD}"
link="$proj/.claude/state"
run_base="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
proj_key="$(basename "$proj")-$(printf '%s' "$proj" | cksum | cut -d' ' -f1)"
rmdir "$link" 2>/dev/null || true # clear an empty leftover real dir
if [ -d "$run_base" ] && [ -w "$run_base" ]; then
  state_dir="$run_base/claude-state-$proj_key"
  mkdir -p "$state_dir" 2>/dev/null || true
  if [ ! -e "$link" ] || [ -L "$link" ]; then
    ln -sfn "$state_dir" "$link" 2>/dev/null || true # create/repoint (heals post-reboot dangle)
  else
    state_dir="$link" # non-empty real dir already there → use it (disk fallback)
  fi
else
  state_dir="$link"
fi
mkdir -p "$state_dir" 2>/dev/null || true

if ! command -v jq >/dev/null 2>&1 || [ -z "$input" ]; then
  printf 'ctx ?%%'
  exit 0
fi

[ -f "$state_dir/quota-raw.json" ] ||
  printf '%s' "$input" >"$state_dir/quota-raw.json" 2>/dev/null

# mtime of a file in epoch seconds: GNU stat, then BSD stat, else 0.
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# One jq pass, one value per line. Each added expression yields exactly one:
# int_or/obj turn a missing or mistyped key into a default instead of an
# error, and txt drops control characters (newlines included), so no payload
# string can shift the lines below it or reach the terminal raw. Miss causes
# are shortened (a trailing _changed dropped, a few renamed) and capped at
# two plus a count of the rest. The last line is the compact JSON of the
# mirror's additive keys.
v=()
while IFS= read -r _line; do v[${#v[@]}]=$_line; done < <(jq -r '
  def int_or(d): if type == "number" and . > -1e15 and . < 1e15 then floor else d end;
  def epoch: if type == "number" and . > 0 and . < 1e15 then floor else 0 end;
  def txt: if type == "string"
    then explode | map(select(. >= 32 and (. < 127 or . > 159))) | implode
    else "" end;
  def obj: if type == "object" then . else {} end;
  def str_or_null: if type == "string" then . else null end;
  def short_cause:
    if . == "ttl_expired_1h" or . == "ttl_expired_5m" then "expired"
    elif . == "likely_server_side" then "server"
    elif . == "messages_rewritten" then "rewritten"
    else rtrimstr("_changed") end;
  (.prompt_cache | obj) as $pc | (.model | obj) as $m |
  ((.context_window.used_percentage // -1) | floor),
  ((.rate_limits.five_hour.used_percentage // -1) | floor),
  ((.rate_limits.five_hour.resets_at // 0) | floor),
  ((.rate_limits.seven_day.used_percentage // -1) | floor),
  ((.rate_limits.seven_day.resets_at // 0) | floor),
  (.cost.total_cost_usd // 0),
  (.session_id // "?"),
  (if .exceeds_200k_tokens == true then 1 else 0 end),
  (if .fast_mode == true then 1 else 0 end),
  (if $pc.caching_observed == false then 0 else ($pc.expires_at | epoch) end),
  ($pc.ttl | txt),
  ($pc.misses | int_or(0)),
  ($pc.last_miss_at | int_or(-1)),
  ($pc.last_miss_cause | obj | .causes
   | if type == "array" then map(txt | short_cause | select(. != "")) else [] end
   | .[0:2] + (if length > 2 then ["\(length - 2)"] else [] end) | join("+")),
  (if ($pc.requests | int_or(0)) >= 5 and ($pc.hit_ratio | type) == "number"
      and $pc.hit_ratio < 0.7
   then $pc.hit_ratio * 100 | round else -1 end),
  ([$m.display_name, $m.id] | map(txt | select(. != "")) | .[0] // "" | ascii_downcase),
  ($m.id | txt),
  (.effort | obj | .level | txt),
  ({cache_warm: ($pc.warm | if type == "boolean" then . else null end),
    cache_ttl: ($pc.ttl | str_or_null),
    cache_expires_at: ($pc.expires_at | epoch),
    cache_hit_ratio: ($pc.hit_ratio | if type == "number" then . else null end),
    cache_requests: ($pc.requests | int_or(null)),
    cache_misses: ($pc.misses | int_or(null)),
    cache_last_miss_at: ($pc.last_miss_at | int_or(null)),
    cache_last_miss_causes: ($pc.last_miss_cause | obj | .causes
                             | if type == "array" then map(strings) else [] end),
    cache_recache_tokens_if_cold: ($pc.recache_tokens_if_cold | int_or(null)),
    effort_level: (.effort | obj | .level | str_or_null),
    model_id: ($m.id | str_or_null),
    model_display: ($m.display_name | str_or_null),
    fast_mode: (.fast_mode == true),
    exceeds_200k: (.exceeds_200k_tokens == true)} | tojson)
' <<<"$input" 2>/dev/null)

ctx="${v[0]:--1}"; fh="${v[1]:--1}"; fhr="${v[2]:-0}"
sd="${v[3]:--1}"; sdr="${v[4]:-0}"; cost="${v[5]:-0}"; sid="${v[6]:-?}"
x200="${v[7]:-0}"; fast="${v[8]:-0}"
cexp="${v[9]:-0}"; cttl="${v[10]:-}"; cmiss="${v[11]:-0}"; clast="${v[12]:--1}"
ccause="${v[13]:-}"; chit="${v[14]:--1}"
mtag="${v[15]:-}"; mid="${v[16]:-}"; eff="${v[17]:-}"; pc_json="${v[18]:-}"
# These feed integer tests below: anything but a plain integer falls back.
[[ $ctx =~ ^-?[0-9]{1,15}$ ]] || ctx=-1
[[ $fh =~ ^-?[0-9]{1,15}$ ]] || fh=-1
[[ $fhr =~ ^[0-9]{1,15}$ ]] || fhr=0
[[ $sd =~ ^-?[0-9]{1,15}$ ]] || sd=-1
[[ $sdr =~ ^[0-9]{1,15}$ ]] || sdr=0
[[ $cost =~ ^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$ ]] || cost=0
[[ $cexp =~ ^[0-9]{1,15}$ ]] || cexp=0
[[ $cmiss =~ ^[0-9]{1,15}$ ]] || cmiss=0
[[ $clast =~ ^-?[0-9]{1,15}$ ]] || clast=-1
[[ $chit =~ ^-?[0-9]{1,15}$ ]] || chit=-1
[[ $pc_json == \{* ]] || pc_json='{}'
now=$(date +%s)

# --- per-model weekly windows, from the CLI's utilization cache ---
# Re-read only when ~/.claude.json actually changed; the parse is cached in
# the state dir as: line 1 = config stamp, line 2 = JSON for the mirror,
# lines 3+ = one TSV row per model (name, pct, resets_at epoch, fetched_at).
cfg="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
[ -f "$cfg" ] || cfg="$HOME/.claude.json"
mw_cache="$state_dir/model-weekly.tsv"
# Sub-second mtime, because the CLI can rewrite the config twice in one second
# and a whole-second stamp would keep serving the pre-write parse; size joins
# it as the fallback stamp where %.9Y is unsupported (BSD stat has neither:
# there it is whole-second mtime + size), and the cache is re-read at least
# once a minute so no missed write can pin an old number for long.
cfg_stamp=$(stat -c '%.9Y:%s' "$cfg" 2>/dev/null || stat -c '%Y:%s' "$cfg" 2>/dev/null || stat -f '%m:%z' "$cfg" 2>/dev/null || echo 0)
mw_age=$(( now - $(mtime_of "$mw_cache") ))
mw_all=()
if [ -f "$mw_cache" ]; then
  while IFS= read -r _line; do mw_all[${#mw_all[@]}]=$_line; done <"$mw_cache"
fi
if [ "${mw_all[0]:-}" != "$cfg_stamp" ] || [ "${#mw_all[@]}" -lt 2 ] ||
   [ "$mw_age" -ge 60 ]; then
  mw_rows=()
  while IFS= read -r _line; do mw_rows[${#mw_rows[@]}]=$_line; done < <(jq -r '
    def iso_epoch:
      if type != "string" then null else
      ((.[0:19] + "Z") | try fromdateiso8601 catch null) as $base
      | ((capture("(?<sign>[+-])(?<oh>[0-9]{2}):?(?<om>[0-9]{2})$")?) // null) as $z
      | if $base == null then null
        elif $z == null then $base
        else $base - (if $z.sign == "-" then -1 else 1 end)
                     * (($z.oh | tonumber) * 3600 + ($z.om | tonumber) * 60)
        end
      end;
    (.cachedUsageUtilization // {}) as $c
    | ((($c.fetchedAtMs // 0) / 1000) | floor) as $at
    | [ ($c.utilization.limits // [])[]
        | select(.kind == "weekly_scoped"
                 and ((.scope.model.display_name // "") | length > 0))
        | {name: .scope.model.display_name, pct: ((.percent // 0) | floor),
           resets_at: (.resets_at // null),
           resets_at_epoch: ((.resets_at // null) | iso_epoch),
           fetched_at: $at} ]
    | sort_by(-.pct) | .[0:2]
    | tojson, (.[] | [.name, .pct, (.resets_at_epoch // 0), .fetched_at] | @tsv)
  ' "$cfg" 2>/dev/null)
  if [ "${#mw_rows[@]}" -ge 1 ]; then
    mw_all=("$cfg_stamp" "${mw_rows[@]}")
    tmp="$state_dir/.model-weekly.tmp"
    printf '%s\n' "${mw_all[@]}" >"$tmp" 2>/dev/null &&
      mv -f "$tmp" "$mw_cache" 2>/dev/null
  else
    mw_all=("$cfg_stamp" "[]") # unreadable config → render without the row
  fi
fi
mw_json="${mw_all[1]:-[]}"
mw=("${mw_all[@]:2}")

# --- state file (atomic; throttled to one write per 10s of renders) ---
# The additive keys start from their defaults, so each one exists even when
# the payload pass failed; cache_remaining_s is cache_expires_at - written_at
# (-1 when there is no expiry), so it can be negative. model_* describes the
# weekly row whose name the active model's name contains (or the reverse).
write_needed=1
if [ -f "$state_dir/quota.json" ]; then
  mtime=$(mtime_of "$state_dir/quota.json")
  [ $((now - mtime)) -lt 10 ] && write_needed=0
fi
if [ "$write_needed" = 1 ]; then
  tmp="$state_dir/.quota.json.tmp"
  if jq -n --argjson fh "$fh" --argjson fhr "$fhr" --argjson sd "$sd" \
       --argjson sdr "$sdr" --argjson ctx "$ctx" --argjson cost "${cost:-0}" \
       --argjson mw "${mw_json:-[]}" --arg sid "$sid" --arg pc "$pc_json" \
       --arg mtag "$mtag" --arg mid "$mid" '
    ([$mtag, $mid] | map(ascii_downcase | select(. != ""))) as $names |
    (first($mw[] | select((.name | ascii_downcase) as $n
                          | ($n != "")
                            and any($names[]; . as $nm
                                    | ($nm | contains($n)) or ($n | contains($nm))))) // null) as $mm |
    {five_hour_pct: $fh, five_hour_resets_at: $fhr,
     seven_day_pct: $sd, seven_day_resets_at: $sdr,
     model_weekly: $mw,
     model_pct: ($mm.pct // -1), model_name: ($mm.name // null),
     model_resets_at: ($mm.resets_at // null),
     model_fetched_at: ($mm.fetched_at // 0),
     model_age_s: (if $mm == null then -1 else ((now | floor) - $mm.fetched_at) end),
     ctx_pct: $ctx, cost_usd: $cost, session_id: $sid,
     written_at: (now | floor)}
    + {cache_warm: null, cache_ttl: null, cache_expires_at: 0,
       cache_remaining_s: -1, cache_hit_ratio: null, cache_requests: null,
       cache_misses: null, cache_last_miss_at: null,
       cache_last_miss_causes: [], cache_recache_tokens_if_cold: null,
       effort_level: null, model_id: null, model_display: null,
       fast_mode: false, exceeds_200k: false}
    + (([$pc | try fromjson catch null] | .[0] | objects) // {})
    | .cache_remaining_s =
        (if (.cache_expires_at | type) == "number" and .cache_expires_at > 0
         then .cache_expires_at - .written_at else -1 end)' >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$state_dir/quota.json" 2>/dev/null || true
  fi
fi

# --- render ---
paint() { # $1 = pct → "NN%" colored red >=80, yellow >=60
  if [ "$1" -ge 80 ]; then
    printf '\033[1;31m%s%%\033[0m' "$1"
  elif [ "$1" -ge 60 ]; then
    printf '\033[33m%s%%\033[0m' "$1"
  else
    printf '%s%%' "$1"
  fi
}

paint_rem() { # $1 = seconds left (> 0) → "NNm" / "<1m", red <180s, yellow <600s
  local r='<1m'
  [ "$1" -ge 60 ] && r="$(( $1 / 60 ))m"
  if [ "$1" -lt 180 ]; then
    printf '\033[1;31m%s\033[0m' "$r"
  elif [ "$1" -lt 600 ]; then
    printf '\033[33m%s\033[0m' "$r"
  else
    printf '%s' "$r"
  fi
}

ago() { # $1 = seconds → compact age
  if [ "$1" -lt 3600 ]; then printf '%dm' $(( $1 / 60 ))
  elif [ "$1" -lt 86400 ]; then printf '%dh' $(( $1 / 3600 ))
  else printf '%dd' $(( $1 / 86400 )); fi
}

fmt_epoch() { # $1 = epoch, $2 = strftime format — GNU first, then BSD/macOS
  date -d "@$1" +"$2" 2>/dev/null || date -r "$1" +"$2" 2>/dev/null || echo '?'
}

STALE_S=900 # a reading older than this is shown as a floor, with its age
C_YEL=$'\033[33m' C_DIM=$'\033[2m' C_OFF=$'\033[0m'

line=""
if [ "$fh" -ge 0 ]; then
  when=$(fmt_epoch "$fhr" '%H:%M')
  line="5h $(paint "$fh")→$when"
fi
if [ "$sd" -ge 0 ]; then
  when=$(fmt_epoch "$sdr" '%b %d')
  line="${line:+$line · }7d $(paint "$sd")→$when"
fi
i=0 # by index: a model name may hold spaces
while [ "$i" -lt "${#mw[@]}" ]; do
  row="${mw[$i]}"; i=$((i + 1))
  IFS=$'\t' read -r mname mpct mrst mat <<<"$row"
  [ -n "$mname" ] || continue
  [[ $mpct =~ ^[0-9]{1,15}$ ]] || continue
  [[ $mrst =~ ^[0-9]{1,15}$ ]] || mrst=0
  [[ $mat =~ ^[0-9]{1,15}$ ]] || mat=0
  label=$(printf '%s' "$mname" | tr '[:upper:]' '[:lower:]')
  if [ "$mrst" -gt 0 ] && [ "$mrst" -le "$now" ]; then
    line="${line:+$line · }$label ?% $(printf '\033[2m(reset)\033[0m')"
    continue # window rolled over after the reading — the % means nothing
  fi
  age=$((now - mat)); stale=0
  [ "$mat" -gt 0 ] && [ "$age" -ge "$STALE_S" ] && stale=1
  seg="$label "
  [ "$stale" = 1 ] && seg="$seg≥"
  seg="$seg$(paint "$mpct")"
  [ "$mrst" -gt 0 ] && seg="$seg→$(fmt_epoch "$mrst" '%b %d')"
  [ "$stale" = 1 ] && seg="$seg $(printf '\033[2m(%s)\033[0m' "$(ago "$age")")"
  line="${line:+$line · }$seg"
done
if [ "$ctx" -ge 0 ]; then
  seg="ctx $(paint "$ctx")"
  [ "$x200" = 1 ] && seg="$seg ${C_YEL}>200k$C_OFF"
  line="${line:+$line · }$seg"
fi
[ -z "$line" ] && line="ctx ?% (no rate data yet)"

# Prompt cache: omitted when the payload has none, no expiry, or caching
# was never observed (cexp is 0 then).
if [ "$cexp" -gt 0 ]; then
  rem=$((cexp - now))
  if [ "$rem" -gt 0 ]; then
    seg="cache $(paint_rem "$rem")→$(fmt_epoch "$cexp" '%H:%M')"
  else
    seg="${C_DIM}cache cold$C_OFF" # expires_at has passed: no clock
  fi
  # A 5m TTL means the plan's included usage is spent (extra usage) or a TTL
  # is forced: worth seeing. 1h shows nothing.
  [ "$cttl" = 5m ] && seg="$seg ${C_YEL}5m ttl$C_OFF"
  miss_age=$((now - clast))
  if [ "$cmiss" -gt 0 ] && [ "$clast" -ge 0 ] && [ "$miss_age" -lt 900 ]; then
    [ "$miss_age" -ge 0 ] || miss_age=0
    seg="$seg $C_DIM(miss $(ago "$miss_age")${ccause:+: $ccause})$C_OFF"
  fi
  [ "$chit" -ge 0 ] && seg="$seg ${C_DIM}hit $chit%$C_OFF"
  line="${line:+$line · }$seg"
fi

# Model and effort, always last. The tag turns yellow when the user settings
# name another model: neither name contains the other, case-insensitively,
# so an alias ("opus") still matches its id ("claude-opus-5-5"). Unreadable
# settings paint nothing.
mwarn=0
if [ -n "$mtag" ] && [ -n "$mid" ]; then
  ufile="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  if [ -f "$ufile" ] && [ -r "$ufile" ]; then
    mwarn=$(jq -r --arg id "$mid" '
      (.model? // null) as $s
      | if ($s | type) == "string" and $s != "" then
          ($s | ascii_downcase) as $a | ($id | ascii_downcase) as $b
          | if ($a | contains($b)) or ($b | contains($a)) then 0 else 1 end
        else 0 end' "$ufile" 2>/dev/null)
    [ "$mwarn" = 1 ] || mwarn=0
  fi
fi
seg="$mtag"
[ -n "$mtag" ] && [ "$mwarn" = 1 ] && seg="$C_YEL$mtag$C_OFF"
[ "$fast" = 1 ] && seg="${seg:+$seg }${C_YEL}fast$C_OFF"
[ -n "$eff" ] && seg="${seg:+$seg · }eff $eff"
[ -n "$seg" ] && line="${line:+$line · }$seg"
printf '%s' "$line"
