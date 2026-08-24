#!/usr/bin/env bash
#
# End-to-end check for over completion, the new-bowler prompt and the
# consecutive-over restriction (docs/api.md → "Over completion and the next
# bowler" and POST /v1/match/:matchId/select-bowler).
#
# Every step asserts, so this either prints PASS lines and exits 0, or names the
# step that broke and exits 1. Three of the steps are NEGATIVE tests: the server
# must refuse them. A run where those come back 200 is a failure even though
# nothing errored.
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-over-completion.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-over-completion.sh
#
# BASE defaults to the dev flavor's base URL, which already ends in /api.
set -uo pipefail

BASE="${BASE:-http://localhost:9000/api}"
PASSES=0

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

# --- plumbing ---------------------------------------------------------------
# Leaves the response body in $BODY and the HTTP status in $CODE.
call() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -w '\n%{http_code}' -X "$method" "$BASE$path"
              -H 'Content-Type: application/json'
              -H 'accept-language: en')
  [ -n "${TOKEN:-}" ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ -n "$data" ] && args+=(-d "$data")

  local raw; raw="$(curl "${args[@]}")"
  CODE="${raw##*$'\n'}"
  BODY="${raw%$'\n'*}"
}

fail() {
  echo
  echo "FAIL: $1"
  echo "  HTTP $CODE"
  echo "  $BODY" | head -c 2000
  echo
  exit 1
}

pass() { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }

# expect <label> <http-status> [<jq-filter> <expected>]...
expect() {
  local label="$1" want="$2"; shift 2
  [ "$CODE" = "$want" ] || fail "$label — expected HTTP $want"
  while [ $# -gt 0 ]; do
    local got; got="$(echo "$BODY" | jq -r "$1")"
    [ "$got" = "$2" ] || fail "$label — $1 was '$got', expected '$2'"
    shift 2
  done
  pass "$label"
}

uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

# --- auth -------------------------------------------------------------------
if [ -z "${TOKEN:-}" ]; then
  [ -n "${EMAIL:-}" ] && [ -n "${PASSWORD:-}" ] || {
    echo "Set TOKEN, or EMAIL and PASSWORD so this can log in."; exit 1; }
  call POST /v1/user/login "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" \
      '{email:$e, password:$p}')"
  [ "$CODE" = "200" ] || fail "login"
  TOKEN="$(echo "$BODY" | jq -r '.data.accessToken')"
  pass "logged in"
fi

STAMP="$(date +%s)"
SHAMI="Mohammed Shami $STAMP"
BUMRAH="Jasprit Bumrah $STAMP"
ROHIT="Rohit Sharma $STAMP"
ISHAN="Ishan Kishan $STAMP"

# --- setup: a 2-over match so the innings also ends inside this run ----------
call POST /v1/match/create "$(jq -nc --arg a "MI $STAMP" --arg b "CSK $STAMP" \
    '{teamAName:$a, teamBName:$b, totalOvers:2}')"
expect "create match (2 overs)" 200 '.data.totalOvers' '2'
MATCH="$(echo "$BODY" | jq -r '.data.matchId')"

# --- NEGATIVE 1: start-innings now requires the opening bowler ---------------
call POST "/v1/match/$MATCH/start-innings" \
    "$(jq -nc --arg s "$ROHIT" --arg n "$ISHAN" '{strikerName:$s, nonStrikerName:$n}')"
expect "NEGATIVE start-innings without a bowler is refused" 400 '.code' 'BOWLER_NAME_REQUIRED'

call POST "/v1/match/$MATCH/start-innings" \
    "$(jq -nc --arg s "$ROHIT" --arg n "$ISHAN" --arg b "$SHAMI" \
       '{strikerName:$s, nonStrikerName:$n, bowlerName:$b}')"
expect "start innings with an opening bowler" 200 '.data.bowler.bowlerName' "$SHAMI"

# --- over 1: five dots, then a single off the last ball ----------------------
# The single is the interesting ball: odd runs rotate AND the over end rotates,
# and they cancel — the same batsman must keep strike into over 2.
ball() { # ball <json-body-fragment> ; leaves BODY/CODE set
  call POST "/v1/match/$MATCH/score-ball" \
      "$(jq -nc --argjson extra "$1" --arg k "$(uuid)" '$extra + {idempotencyKey:$k}')"
}

for i in 1 2 3 4 5; do
  ball '{"runs":0}'
  expect "over 1 ball $i (dot)" 200 '.data.overComplete' 'false' '.data.nextBowler' 'null'
done

LAST_KEY="$(uuid)"
call POST "/v1/match/$MATCH/score-ball" \
    "$(jq -nc --arg k "$LAST_KEY" '{runs:1, idempotencyKey:$k}')"
expect "over 1 ball 6 (single) completes the over" 200 \
  '.data.overComplete' 'true' \
  '.data.inningsComplete' 'false' \
  '.data.over.bowlerName' "$SHAMI" \
  '.data.over.legalDeliveries' '6' \
  '.data.nextBowler.excludedBowlerName' "$SHAMI"

# The XOR rule, checked end-to-end: a single off the 6th ball must NOT change
# who is facing. If this ever flips, the console will show the wrong striker for
# the first ball of every over that ends in an odd number of runs.
expect "single off the last ball leaves the same batsman on strike" 200 \
  '.data.strike.rotated' 'false' \
  '.data.strike.strikerName' "$ROHIT" \
  '.data.strike.rotationReason' 'null'

# Replaying the over-completing key must return the same answer, prompt included.
call POST "/v1/match/$MATCH/score-ball" \
    "$(jq -nc --arg k "$LAST_KEY" '{runs:1, idempotencyKey:$k}')"
expect "replaying the over-completing ball is idempotent" 200 \
  '.data.overComplete' 'true' \
  '.data.nextBowler.excludedBowlerName' "$SHAMI" \
  '.data.inningsComplete' 'false'

# --- NEGATIVE 2: the headline. Same bowler two overs running is refused ------
call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$SHAMI" '{bowlerName:$b}')"
expect "NEGATIVE the previous over's bowler is REJECTED, not just discouraged" 400 \
  '.code' 'BOWLER_CANNOT_BOWL_CONSECUTIVE_OVERS'

# --- NEGATIVE 3: and scoring is blocked until somebody is chosen -------------
ball '{"runs":0}'
expect "NEGATIVE scoring with no bowler selected is refused" 400 '.code' 'BOWLER_NOT_SELECTED'

# --- over 2 -----------------------------------------------------------------
call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$BUMRAH" '{bowlerName:$b}')"
expect "a different bowler is accepted for over 2" 200 \
  '.data.overNumber' '2' \
  '.data.bowler.bowlerName' "$BUMRAH" \
  '.data.previousBowler.bowlerName' "$SHAMI"

ball '{"runs":0}'
expect "over 2 ball 1" 200 '.data.overComplete' 'false'

# --- NEGATIVE 4: too late to change the bowler once the over has begun -------
call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$SHAMI" '{bowlerName:$b}')"
expect "NEGATIVE changing the bowler mid-over is refused" 400 '.code' 'OVER_ALREADY_STARTED'

for i in 2 3 4 5; do
  ball '{"runs":0}'
  expect "over 2 ball $i (dot)" 200 '.data.overComplete' 'false'
done

# Sixth ball of the second and final over: the over ends, and so does the
# innings — so there must be NO bowler prompt this time.
ball '{"runs":0}'
expect "final ball of the final over ends the innings" 200 \
  '.data.overComplete' 'true' \
  '.data.inningsComplete' 'true' \
  '.data.over.bowlerName' "$BUMRAH" \
  '.data.nextBowler' 'null'

# --- NEGATIVE 5: nothing more can be scored ---------------------------------
ball '{"runs":0}'
expect "NEGATIVE scoring past the last over is refused" 400 '.code' 'INNINGS_COMPLETED'

call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$SHAMI" '{bowlerName:$b}')"
expect "NEGATIVE selecting a bowler after the innings ends is refused" 400 '.code' 'INNINGS_COMPLETED'

echo
echo "All $PASSES checks passed. matchId=$MATCH"
