# Delegated Scoring — curl walkthrough

Every request/response pair below is the exact shape exercised by the passing test suite
(`tests/assignScorer.test.js`, `tests/scorerCandidates.test.js`, `tests/scoringFlow.test.js`) — not
hand-typed guesses. Replace `<BASE>` with your dev server's base URL (e.g. `http://<LAN-IP>:9000/api`)
and each `<...Token>`/`<...Id>` with real values from your own run.

## Path 1: org-owned delegation — the assigned scorer can write

1. Owner logs in and creates an organization:
```bash
curl -X POST <BASE>/v1/organization \
  -H "Authorization: Bearer <ownerToken>" -H "Content-Type: application/json" \
  -d '{"name": "Riverside CC"}'
```
Response carries `data.id` — this is `<orgId>` below.

2. Owner adds a second registered user as a member:
```bash
curl -X POST <BASE>/v1/organization/<orgId>/members \
  -H "Authorization: Bearer <ownerToken>" -H "Content-Type: application/json" \
  -d '{"email": "scorer@example.com"}'
```
Response: `{ "id": "<scorerId>", "name": "...", "role": "member" }`.

3. Owner creates a team under the org:
```bash
curl -X POST <BASE>/v1/organization/<orgId>/teams \
  -H "Authorization: Bearer <ownerToken>" -H "Content-Type: application/json" \
  -d '{"name": "Riverside U19"}'
```
Response carries `data.id` — this is `<teamId>` below.

4. Owner creates a match using that org team against an ad-hoc opponent:
```bash
curl -X POST <BASE>/v1/match/create \
  -H "Authorization: Bearer <ownerToken>" -H "Content-Type: application/json" \
  -d '{"teamAId": "<teamId>", "teamBName": "Visitors", "totalOvers": 5}'
```
Response carries `data.matchId` — this is `<matchId>` below.

5. Owner delegates scoring to the member:
```bash
curl -X PATCH <BASE>/v1/match/<matchId>/scorer \
  -H "Authorization: Bearer <ownerToken>" -H "Content-Type: application/json" \
  -d '{"scorerId": "<scorerId>"}'
```
```json
{
  "statusCode": 200,
  "data": { "matchId": "<matchId>", "assignedScorer": { "id": "<scorerId>", "name": "Test User" } },
  "message": "Scorer assigned",
  "success": true
}
```

6. The assigned scorer — using **their own token**, not the owner's — starts the innings and scores a
   ball successfully:
```bash
curl -X POST <BASE>/v1/match/<matchId>/start-innings \
  -H "Authorization: Bearer <scorerToken>" -H "Content-Type: application/json" \
  -d '{"strikerName": "A", "nonStrikerName": "B", "bowlerName": "C"}'
# -> 200

curl -X POST <BASE>/v1/match/<matchId>/score-ball \
  -H "Authorization: Bearer <scorerToken>" -H "Content-Type: application/json" \
  -d '{"runs": 1, "idempotencyKey": "<a-fresh-uuid>"}'
# -> 200
```

## Path 2: a plain org member (not owner, not assigned) is rejected

Continuing from the setup above, a second member the owner added to the org but never assigned as
scorer attempts to score the same match:
```bash
curl -X POST <BASE>/v1/match/<matchId>/score-ball \
  -H "Authorization: Bearer <plainMemberToken>" -H "Content-Type: application/json" \
  -d '{"runs": 1, "idempotencyKey": "<a-fresh-uuid>"}'
```
```json
{ "statusCode": 403, "code": "MATCH_NOT_OWNED", "message": "You do not have permission to score this match" }
```
This is the same 403/`MATCH_NOT_OWNED` a total stranger would get — being a member of the org that owns
`teamA` is not, by itself, enough to score this specific match. Only the creator and the one
specifically-assigned scorer can.

## Verification notes (Phase 2)

- Full suite: 65 test files, 595 tests, all passing (`npx jest --maxWorkers=2`).
- `tests/locales.test.js` and `tests/routes.auth.test.js`: both passing — no locale-parity gap, no
  route missing `verifyJwt`.
- No lint script exists in this project (`package.json` has no `"lint"` entry) — skipped per the
  project's own tooling, not an oversight.
