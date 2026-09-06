#!/usr/bin/env bash
#
# End-to-end check for tournament leaderboards (docs/api.md ->
# "GET /v1/tournament/:tournamentId/leaderboards").
#
# Creates an organization, a round_robin tournament, and 3 teams; generates
# fixtures; plays two matches so one player's batting and another's bowling
# accumulate across both; abandons a third match mid-innings to prove that
# contribution is excluded. Prints both leaderboards for a human to eyeball,
# plus the specific assertions that make the multi-match summation and the
# abandoned-match exclusion visible rather than just "it returned 200".
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-leaderboards.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-leaderboards.sh
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

call POST /v1/organization "$(jq -nc --arg n "Leaderboards Verify $STAMP" '{name:$n}')"
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

# The POST response only carries round 1 — the full multi-round schedule
# (a 3-team round-robin spans 3 rounds, one bye + one real match each) only
# comes back from a separate GET.
call GET "/v1/tournament/$TOURNAMENT_ID/fixtures"
expect "list fixtures" 200
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

# playInnings <striker> <nonStriker> <bowler> <runsPerBall>
playInnings() {
  startInnings "$1" "$2" "$3"
  for i in 1 2 3 4 5 6; do ball "$4"; expect "score ball" 200; done
}

echo
echo "== Match 1: Alpha vs Charlie (completed) — Rahul bats, Vijay bowls =="
startMatch "$(fixtureBetween "$ALPHA" "$CHARLIE")" 1
playInnings "Rahul" "Kiran" "Vijay" 2
playInnings "Suresh" "Naveen" "Rahul" 0

echo
echo "== Match 2: Bravo vs Charlie (completed) — Vijay bowls again =="
startMatch "$(fixtureBetween "$BRAVO" "$CHARLIE")" 1
playInnings "Manoj" "Deepak" "Vijay" 1
playInnings "Suresh" "Naveen" "Manoj" 0

echo
echo "== Match 3: Alpha vs Bravo — Rahul bats 2 balls, then abandoned =="
startMatch "$(fixtureBetween "$ALPHA" "$BRAVO")" 20
startInnings "Rahul" "Kiran" "Manoj"
ball 4; expect "score ball" 200
ball 4; expect "score ball" 200
call POST "/v1/match/$MATCH/abandon" ""
expect "abandon match" 200

echo
echo "== Fetching leaderboards =="
call GET "/v1/tournament/$TOURNAMENT_ID/leaderboards"
expect "get leaderboards" 200

echo "Batting:"; echo "$BODY" | jq '.data.battingLeaderboard'
echo "Bowling:"; echo "$BODY" | jq '.data.bowlingLeaderboard'

RAHUL_RUNS="$(echo "$BODY" | jq -r '.data.battingLeaderboard[] | select(.playerName=="Rahul") | .runs')"
RAHUL_INNINGS="$(echo "$BODY" | jq -r '.data.battingLeaderboard[] | select(.playerName=="Rahul") | .inningsBatted')"
[ "$RAHUL_RUNS" = "12" ] || fail "Rahul should have 12 runs (only match 1 — the abandoned match's 8 runs must not count), got $RAHUL_RUNS"
pass "Rahul has 12 runs — the abandoned match's runs were correctly excluded"
[ "$RAHUL_INNINGS" = "1" ] || fail "Rahul should show 1 innings batted, got $RAHUL_INNINGS"
pass "Rahul shows 1 innings batted"

VIJAY_DELIVERIES="$(echo "$BODY" | jq -r '.data.bowlingLeaderboard[] | select(.playerName=="Vijay") | .legalDeliveries')"
VIJAY_RUNS="$(echo "$BODY" | jq -r '.data.bowlingLeaderboard[] | select(.playerName=="Vijay") | .runsConceded')"
[ "$VIJAY_DELIVERIES" = "12" ] || fail "Vijay should show 12 legal deliveries (6 per match, 2 matches), got $VIJAY_DELIVERIES"
pass "Vijay shows 12 legal deliveries across both matches"
[ "$VIJAY_RUNS" = "18" ] || fail "Vijay should have conceded 18 runs (12 + 6), got $VIJAY_RUNS"
pass "Vijay's runs conceded sum correctly across both matches (18)"

echo
echo "$PASSES checks passed."
