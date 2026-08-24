#!/usr/bin/env bash
#
# End-to-end check for POST /v1/match/:matchId/undo-ball (docs/api.md → the undo
# section).
#
# The core of it is the requested sequence: score three balls — one extra, one
# ordinary, one wicket — undo the third, and assert the innings is byte-for-byte
# what it was before that ball. The comparison is against the state the SERVER
# reported after ball 2, not against preEventState, so it cannot pass by reading
# back the same snapshot the restore was built from.
#
# It then checks the things that are easy to get wrong: undo is idempotent, an
# older ball is refused, an over-ending ball restores the bowler it cleared, and
# an over left with no deliveries is deleted rather than kept with a stale
# bowlerId.
#
# Every step asserts, so this either prints PASS lines and exits 0, or names the
# step that broke and exits 1. Some steps are NEGATIVE tests: the server must
# refuse them, and a 200 there is a failure even though nothing errored.
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-undo.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-undo.sh
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
JADEJA="Ravindra Jadeja $STAMP"
ROHIT="Rohit Sharma $STAMP"
ISHAN="Ishan Kishan $STAMP"
SURYA="Suryakumar Yadav $STAMP"

# --- setup: 5 overs, so nothing here trips the innings limit -----------------
call POST /v1/match/create "$(jq -nc --arg a "MI $STAMP" --arg b "CSK $STAMP" \
    '{teamAName:$a, teamBName:$b, totalOvers:5}')"
expect "create match (5 overs)" 200 '.data.totalOvers' '5'
MATCH="$(echo "$BODY" | jq -r '.data.matchId')"

call POST "/v1/match/$MATCH/start-innings" \
    "$(jq -nc --arg s "$ROHIT" --arg n "$ISHAN" --arg b "$SHAMI" \
       '{strikerName:$s, nonStrikerName:$n, bowlerName:$b}')"
expect "start innings" 200 '.data.bowler.bowlerName' "$SHAMI"

ball() { # ball <json-fragment> ; leaves BODY/CODE set
  call POST "/v1/match/$MATCH/score-ball" \
      "$(jq -nc --argjson extra "$1" --arg k "$(uuid)" '$extra + {idempotencyKey:$k}')"
}

undo() { # undo <ballEventId>
  call POST "/v1/match/$MATCH/undo-ball" "$(jq -nc --arg b "$1" '{ballEventId:$b}')"
}

echo
echo "── the requested sequence: extra, ordinary ball, wicket, undo ──"

# Ball 1 — the extra. A wide: 1 to the team, and the over does NOT advance.
ball '{"runs":0,"extraType":"wide"}'
expect "ball 1 — wide" 200 \
  '.data.isLegal' 'false' \
  '.data.extras' '1' \
  '.data.inningsTotals.totalRuns' '1' \
  '.data.inningsTotals.legalBalls' '0' \
  '.data.inningsTotals.extras.wides' '1'
BALL1="$(echo "$BODY" | jq -r '.data.ballEventId')"

# Ball 2 — ordinary single. Odd runs, so the pair rotates.
ball '{"runs":1}'
expect "ball 2 — single rotates the strike" 200 \
  '.data.inningsTotals.totalRuns' '2' \
  '.data.inningsTotals.legalBalls' '1' \
  '.data.strike.rotated' 'true' \
  '.data.strike.strikerName' "$ISHAN"

# THE BASELINE. Built from the innings as the server saw it after ball 2 —
# independent of the preEventState the undo will restore from.
BEFORE="$(echo "$BODY" | jq -Sc '{
  totals: .data.inningsTotals,
  strike: {
    strikerId:      .data.strike.strikerId,
    strikerName:    .data.strike.strikerName,
    nonStrikerId:   .data.strike.nonStrikerId,
    nonStrikerName: .data.strike.nonStrikerName
  }
}')"
echo "      baseline before ball 3: $BEFORE"

# Ball 3 — the wicket. Changes the count AND replaces a batsman, so a restore
# that only reversed arithmetic would still leave the wrong pair at the crease.
ball "$(jq -nc --arg i "$SURYA" '{runs:0, wicketType:"caught", incomingBatsmanName:$i}')"
expect "ball 3 — caught, incoming batsman takes strike" 200 \
  '.data.inningsTotals.wickets' '1' \
  '.data.inningsTotals.legalBalls' '2' \
  '.data.wicket.type' 'caught' \
  '.data.wicket.dismissedPlayerName' "$ISHAN" \
  '.data.strike.strikerName' "$SURYA"
BALL3="$(echo "$BODY" | jq -r '.data.ballEventId')"

# The undo itself.
undo "$BALL3"
expect "undo ball 3" 200 \
  '.data.alreadyUndone' 'false' \
  '.data.undone.ballEventId' "$BALL3" \
  '.data.undone.wicket.type' 'caught' \
  '.data.overRemoved' 'false' \
  '.data.overReopened' 'false' \
  '.data.inningsReopened' 'false' \
  '.data.inningsComplete' 'false' \
  '.data.canUndo' 'true' \
  '.data.bowler.currentBowlerName' "$SHAMI"

AFTER="$(echo "$BODY" | jq -Sc '{totals: .data.inningsTotals, strike: .data.strike}')"
echo "      state after undo:       $AFTER"

[ "$BEFORE" = "$AFTER" ] || {
  echo
  echo "FAIL: state after undo does not match the state before ball 3"
  echo "  before: $BEFORE"
  echo "  after:  $AFTER"
  exit 1
}
pass "state after undo is EXACTLY the state before ball 3"

# Named separately because the pair is the half a naive restore gets wrong: the
# dismissed batsman has to come back, and the incoming one has to disappear.
expect "the dismissed batsman is back at the crease" 200 \
  '.data.strike.strikerName' "$ISHAN" \
  '.data.strike.nonStrikerName' "$ROHIT"

echo
echo "── idempotency and refusals ──"

# The double-tap. Same id again: nothing more may be removed.
undo "$BALL3"
expect "NEGATIVE re-undoing the same ball is a no-op, not a second undo" 200 \
  '.data.alreadyUndone' 'true' \
  '.data.undone' 'null' \
  '.data.inningsTotals.totalRuns' '2' \
  '.data.inningsTotals.legalBalls' '1' \
  '.data.inningsTotals.wickets' '0'

undo "$BALL1"
expect "NEGATIVE undoing an older ball is refused" 400 '.code' 'BALL_NOT_LATEST'

undo "not-an-object-id"
expect "NEGATIVE a malformed ball id is refused" 400 '.code' 'INVALID_BALL_EVENT_ID'

call POST "/v1/match/$MATCH/undo-ball" '{}'
expect "NEGATIVE a missing ball id is refused" 400 '.code' 'BALL_EVENT_ID_REQUIRED'

echo
echo "── scoring resumes cleanly after an undo ──"

ball '{"runs":4}'
expect "re-scoring after the undo lands on the restored innings" 200 \
  '.data.inningsTotals.totalRuns' '6' \
  '.data.inningsTotals.legalBalls' '2' \
  '.data.inningsTotals.wickets' '0' \
  '.data.overComplete' 'false'

echo
echo "── undoing the ball that ends an over restores the bowler it cleared ──"

# Fill over 1 to five legal balls, then end it.
for i in 3 4 5; do
  ball '{"runs":0}'
  expect "over 1 legal ball $i" 200 '.data.overComplete' 'false'
done

ball '{"runs":0}'
expect "over 1 ball 6 completes the over" 200 \
  '.data.overComplete' 'true' \
  '.data.over.bowlerName' "$SHAMI" \
  '.data.nextBowler.excludedBowlerName' "$SHAMI"
OVER1_LAST="$(echo "$BODY" | jq -r '.data.ballEventId')"

# A bowler is now chosen for over 2 — and then the ball that ended over 1 is
# undone. Over 1 is unfinished again, so this selection must be discarded and
# over 1's own bowler restored.
call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$BUMRAH" '{bowlerName:$b}')"
expect "select Bumrah for over 2" 200 '.data.bowler.bowlerName' "$BUMRAH"

undo "$OVER1_LAST"
expect "undoing the over-ending ball reopens the over and restores its bowler" 200 \
  '.data.overReopened' 'true' \
  '.data.overRemoved' 'false' \
  '.data.bowler.currentBowlerName' "$SHAMI" \
  '.data.inningsTotals.oversCompleted' '0' \
  '.data.inningsTotals.legalBalls' '5' \
  '.data.overs' '0.5'

# And scoring continues without a select-bowler call, which is the practical
# proof that no bowler is owed.
ball '{"runs":0}'
expect "over 1 ball 6 re-scored, no new bowler needed" 200 \
  '.data.overComplete' 'true' \
  '.data.over.bowlerName' "$SHAMI"

echo
echo "── an over left with no deliveries is deleted, not kept ──"

call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$BUMRAH" '{bowlerName:$b}')"
expect "select Bumrah for over 2 again" 200 '.data.bowler.bowlerName' "$BUMRAH"

ball '{"runs":2}'
expect "over 2 ball 1" 200 \
  '.data.overNumber' '2' \
  '.data.inningsTotals.oversCompleted' '1'
OVER2_FIRST="$(echo "$BODY" | jq -r '.data.ballEventId')"

undo "$OVER2_FIRST"
expect "undoing the only ball of an over removes the over document" 200 \
  '.data.overRemoved' 'true' \
  '.data.overReopened' 'false' \
  '.data.bowler.currentBowlerName' "$BUMRAH"

# The reason the over document has to go: Over.bowlerId is stamped once, at
# creation. A stale document left behind would keep Bumrah, and this newly
# selected bowler would be silently ignored when the over is credited.
call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$JADEJA" '{bowlerName:$b}')"
expect "re-select Jadeja for over 2 after the undo" 200 '.data.bowler.bowlerName' "$JADEJA"

for i in 1 2 3 4 5; do
  ball '{"runs":0}'
  expect "over 2 ball $i" 200 '.data.overComplete' 'false'
done

ball '{"runs":0}'
expect "over 2 is credited to Jadeja, not to the discarded selection" 200 \
  '.data.overComplete' 'true' \
  '.data.over.bowlerName' "$JADEJA" \
  '.data.over.legalDeliveries' '6' \
  '.data.inningsTotals.oversCompleted' '2'

echo
echo "$PASSES checks passed."
