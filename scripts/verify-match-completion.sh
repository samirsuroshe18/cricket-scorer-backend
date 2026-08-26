#!/usr/bin/env bash
#
# End-to-end check for match completion (docs/api.md → "Match and innings
# completion", GET .../scorecard, and the socket contract's match:complete).
#
# Drives all three innings-ending conditions through the real HTTP contract —
# create, start innings 1, score to end it, start innings 2, score to end the
# match — one match per condition, in one dedicated match each so a failure in
# one condition can't be blamed on state left over from another:
#
#   overs_complete   — both innings run out of overs, nobody all out
#   all_out          — innings 1 loses all ten wickets mid-over
#   target_achieved  — innings 2 passes the target mid-over, before its own
#                       overs or wickets could have ended it
#
# Each asserts the ball that ends the innings, the target start-innings hands
# back for innings 2, the match.result GET .../scorecard reports, and (for
# all_out) that the generated Scorecard actually has batting lines in it —
# not just that the numbers add up.
#
# Every step asserts, so this either prints PASS lines and exits 0, or names
# the step that broke and exits 1.
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-match-completion.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-match-completion.sh
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

# newMatch <label> <totalOvers> — leaves MATCH set.
newMatch() {
  call POST /v1/match/create "$(jq -nc --arg a "$1 A $STAMP" --arg b "$1 B $STAMP" --argjson o "$2" \
      '{teamAName:$a, teamBName:$b, totalOvers:$o}')"
  expect "$1: create match ($2 overs)" 200 '.data.totalOvers' "$2"
  MATCH="$(echo "$BODY" | jq -r '.data.matchId')"
}

# startInnings <label> <striker> <nonStriker> <bowler>
startInnings() {
  call POST "/v1/match/$MATCH/start-innings" \
      "$(jq -nc --arg s "$2" --arg n "$3" --arg b "$4" \
         '{strikerName:$s, nonStrikerName:$n, bowlerName:$b}')"
  expect "$1: start innings" 200 '.data.bowler.bowlerName' "$4"
}

selectBowler() { # selectBowler <label> <bowler>
  call POST "/v1/match/$MATCH/select-bowler" "$(jq -nc --arg b "$2" '{bowlerName:$b}')"
  expect "$1: select $2" 200 '.data.bowler.bowlerName' "$2"
}

ball() { # ball <json-fragment> ; leaves BODY/CODE set, no assertion
  call POST "/v1/match/$MATCH/score-ball" \
      "$(jq -nc --argjson extra "$1" --arg k "$(uuid)" '$extra + {idempotencyKey:$k}')"
}

echo
echo "══ overs_complete: both innings run out of overs ══"

newMatch "overs" 1
startInnings "overs" "S1 $STAMP" "S2 $STAMP" "B1 $STAMP"

for i in 1 2 3 4 5; do ball '{"runs":1}'; done
ball '{"runs":1}'
expect "overs: innings 1 ends on the last ball of over 1, not the match" 200 \
  '.data.inningsComplete' 'true' \
  '.data.matchComplete' 'false' \
  '.data.inningsTotals.totalRuns' '6'

startInnings "overs" "S3 $STAMP" "S4 $STAMP" "B2 $STAMP"
expect "overs: innings 2 target is innings 1's total plus one" 200 '.data.target' '7'

for i in 1 2 3 4 5; do ball '{"runs":0}'; done
ball '{"runs":0}'
expect "overs: match ends on the last ball, short of the target" 200 \
  '.data.matchComplete' 'true' \
  '.data.inningsTotals.totalRuns' '0'

call GET "/v1/match/$MATCH/scorecard"
expect "overs: result is a runs win for the side batting first" 200 \
  '.data.result.winner' 'teamA' \
  '.data.result.marginType' 'runs' \
  '.data.result.margin' '6'

echo
echo "══ all_out: innings 1 loses all ten wickets mid-over ══"

newMatch "allout" 20
startInnings "allout" "P1 $STAMP" "P2 $STAMP" "BW1 $STAMP"

for w in 1 2 3 4 5 6; do
  ball "$(jq -nc --arg i "In$w $STAMP" '{runs:0, wicketType:"bowled", dismissedBatsman:"striker", incomingBatsmanName:$i}')"
  expect "allout: wicket $w" 200 '.data.wicket.type' 'bowled'
done
# 6 legal deliveries (every wicket ball is one) closed over 1 — a fresh bowler
# is owed before over 2, same rule as any other over boundary.
selectBowler "allout" "BW2 $STAMP"

for w in 7 8 9; do
  ball "$(jq -nc --arg i "In$w $STAMP" '{runs:0, wicketType:"bowled", dismissedBatsman:"striker", incomingBatsmanName:$i}')"
  expect "allout: wicket $w" 200 '.data.wicket.type' 'bowled'
done

ball '{"runs":0,"wicketType":"bowled","dismissedBatsman":"striker"}'
expect "allout: the 10th wicket ends the innings mid-over, not the match" 200 \
  '.data.wicket.type' 'bowled' \
  '.data.inningsComplete' 'true' \
  '.data.matchComplete' 'false' \
  '.data.inningsTotals.wickets' '10' \
  '.data.inningsTotals.totalRuns' '0'

startInnings "allout" "P11 $STAMP" "P12 $STAMP" "BW1 $STAMP"
expect "allout: target is 1 — nobody scored a run in innings 1" 200 '.data.target' '1'

ball '{"runs":1}'
expect "allout: a single on ball 1 chases down a target of 1" 200 '.data.matchComplete' 'true'

call GET "/v1/match/$MATCH/scorecard"
expect "allout: result is a 10-wicket win for the side batting second" 200 \
  '.data.result.winner' 'teamB' \
  '.data.result.marginType' 'wickets' \
  '.data.result.margin' '10'
expect "allout: the generated scorecard has real batting lines, not a stub" 200 \
  '.data.innings[0].battingScores[0].dismissalType' 'bowled'

echo
echo "══ target_achieved: innings 2 passes the target mid-over ══"

newMatch "chase" 5
startInnings "chase" "C1 $STAMP" "C2 $STAMP" "CB1 $STAMP"

BOWLER_N=1
for over in 0 1 2 3 4; do
  if [ "$over" -gt 0 ]; then
    BOWLER_N=$((BOWLER_N + 1))
    selectBowler "chase" "CB$BOWLER_N $STAMP"
  fi
  for i in 1 2 3 4 5; do ball '{"runs":1}'; done
  if [ "$over" -eq 4 ]; then ball '{"runs":0}'; else ball '{"runs":1}'; fi
done
expect "chase: innings 1 ends at 29 via overs_complete, no wicket involved" 200 \
  '.data.wicket' 'null' \
  '.data.inningsComplete' 'true' \
  '.data.inningsTotals.totalRuns' '29'

startInnings "chase" "C3 $STAMP" "C4 $STAMP" "CB1 $STAMP"
expect "chase: target is 30" 200 '.data.target' '30'

for i in 1 2 3 4; do ball '{"runs":6}'; done
ball '{"runs":6}'
expect "chase: the 5th six ends the match mid-over, not on an over boundary" 200 \
  '.data.matchComplete' 'true' \
  '.data.overComplete' 'false' \
  '.data.inningsTotals.totalRuns' '30'

call GET "/v1/match/$MATCH/scorecard"
expect "chase: a target-achieved win is wickets, not runs" 200 \
  '.data.result.winner' 'teamB' \
  '.data.result.marginType' 'wickets' \
  '.data.result.margin' '10'

echo
echo "$PASSES checks passed."
