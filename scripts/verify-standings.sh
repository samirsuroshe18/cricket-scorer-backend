#!/usr/bin/env bash
#
# End-to-end check for the points table (docs/api.md ->
# "GET /v1/tournament/:tournamentId/standings").
#
# Creates an organization, a round_robin tournament, and 3 teams; generates
# fixtures; plays two matches with controlled margins so one pair of teams
# ends up level on points and must be split by NRR; abandons a third match
# to prove it counts as a no-result excluded from NRR. Prints the resulting
# table for a human to eyeball, plus the specific assertions that make the
# tiebreak and exclusion rules visible rather than just "it returned 200".
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-standings.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-standings.sh
#
# BASE defaults to the dev flavor's base URL, which already ends in /api.
set -uo pipefail

BASE="${BASE:-http://localhost:9000/api}"
PASSES=0

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

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

call POST /v1/organization "$(jq -nc --arg n "Standings Verify $STAMP" '{name:$n}')"
expect "create organization" 200
ORG_ID="$(echo "$BODY" | jq -r '.data.id')"

call POST "/v1/organization/$ORG_ID/tournaments" "$(jq -nc --arg n "Cup $STAMP" '{name:$n, format:"round_robin"}')"
expect "create round_robin tournament" 200
TOURNAMENT_ID="$(echo "$BODY" | jq -r '.data.id')"

newTeam() { # newTeam <name> -> sets TEAM
  call POST "/v1/organization/$ORG_ID/teams" "$(jq -nc --arg n "$1 $STAMP" '{name:$n}')"
  expect "create team $1" 200
  TEAM="$(echo "$BODY" | jq -r '.data.id')"
}

newTeam "Alpha"; ALPHA="$TEAM"
newTeam "Bravo"; BRAVO="$TEAM"
newTeam "Charlie"; CHARLIE="$TEAM"

for T in "$ALPHA" "$BRAVO" "$CHARLIE"; do
  call POST "/v1/tournament/$TOURNAMENT_ID/teams" "$(jq -nc --arg t "$T" '{teamId:$t}')"
  expect "enroll team" 200
done

call POST "/v1/tournament/$TOURNAMENT_ID/fixtures" ""
expect "generate fixtures" 200
FIXTURES_JSON="$BODY"

fixtureBetween() { # fixtureBetween <teamId> <teamId>
  echo "$FIXTURES_JSON" | jq -r --arg a "$1" --arg b "$2" \
    '.data.fixtures[] | select(.teamB != null) | select((.teamA.id==$a and .teamB.id==$b) or (.teamA.id==$b and .teamB.id==$a)) | .id'
}

startMatch() { # startMatch <fixtureId> <overs> -> sets MATCH
  call POST "/v1/tournament/$TOURNAMENT_ID/fixtures/$1/start-match" "$(jq -nc --argjson o "$2" '{totalOvers:$o}')"
  expect "start match" 200
  MATCH="$(echo "$BODY" | jq -r '.data.matchId')"
}

startInnings() { # startInnings <striker> <nonStriker> <bowler>
  call POST "/v1/match/$MATCH/start-innings" \
      "$(jq -nc --arg s "$1" --arg n "$2" --arg b "$3" '{strikerName:$s, nonStrikerName:$n, bowlerName:$b}')"
  expect "start innings" 200
}

ball() { call POST "/v1/match/$MATCH/score-ball" "$(jq -nc --argjson r "$1" --arg k "$(uuid)" '{runs:$r, idempotencyKey:$k}')"; }

# playOut <firstInningsRunPerBall> <secondInningsRunPerBall>
playOut() {
  startInnings "S1-$STAMP" "S2-$STAMP" "B1-$STAMP"
  for i in 1 2 3 4 5 6; do ball "$1"; expect "score ball (innings 1)" 200; done
  startInnings "S3-$STAMP" "S4-$STAMP" "B2-$STAMP"
  for i in 1 2 3 4 5 6; do ball "$2"; expect "score ball (innings 2)" 200; done
}

echo
echo "== Alpha vs Charlie: Alpha wins big (30 vs 0) =="
startMatch "$(fixtureBetween "$ALPHA" "$CHARLIE")" 1
playOut 5 0

echo
echo "== Bravo vs Charlie: Bravo wins narrowly (6 vs 0) =="
startMatch "$(fixtureBetween "$BRAVO" "$CHARLIE")" 1
playOut 1 0

echo
echo "== Alpha vs Bravo: abandoned (counts as no-result, excluded from NRR) =="
startMatch "$(fixtureBetween "$ALPHA" "$BRAVO")" 20
call POST "/v1/match/$MATCH/abandon" ""
expect "abandon match" 200

echo
echo "== Fetching standings =="
call GET "/v1/tournament/$TOURNAMENT_ID/standings"
expect "get standings" 200 '.data.format' 'round_robin'

echo "$BODY" | jq '.data.standings'

ALPHA_POINTS="$(echo "$BODY" | jq -r --arg id "$ALPHA" '.data.standings[] | select(.teamId==$id) | .points')"
BRAVO_POINTS="$(echo "$BODY" | jq -r --arg id "$BRAVO" '.data.standings[] | select(.teamId==$id) | .points')"
ALPHA_NRR="$(echo "$BODY" | jq -r --arg id "$ALPHA" '.data.standings[] | select(.teamId==$id) | .nrr')"
BRAVO_NRR="$(echo "$BODY" | jq -r --arg id "$BRAVO" '.data.standings[] | select(.teamId==$id) | .nrr')"

[ "$ALPHA_POINTS" = "3" ] || fail "Alpha should have 3 points (2 for the win + 1 for the no-result), got $ALPHA_POINTS"
pass "Alpha has 3 points"
[ "$BRAVO_POINTS" = "3" ] || fail "Bravo should have 3 points (2 for the win + 1 for the no-result), got $BRAVO_POINTS"
pass "Bravo has 3 points"

python3 -c "import sys; sys.exit(0 if float('$ALPHA_NRR') > float('$BRAVO_NRR') else 1)" \
  || fail "Alpha's NRR ($ALPHA_NRR) should be higher than Bravo's ($BRAVO_NRR) — Alpha's win margin was bigger"
pass "Alpha's NRR ($ALPHA_NRR) beats Bravo's ($BRAVO_NRR) despite equal points — tiebreak confirmed"

ALPHA_ORDER="$(echo "$BODY" | jq -r --arg id "$ALPHA" '[.data.standings[].teamId] | index($id)')"
BRAVO_ORDER="$(echo "$BODY" | jq -r --arg id "$BRAVO" '[.data.standings[].teamId] | index($id)')"
[ "$ALPHA_ORDER" -lt "$BRAVO_ORDER" ] || fail "Alpha should rank above Bravo"
pass "Alpha ranks above Bravo in the table"

echo
echo "$PASSES checks passed."
