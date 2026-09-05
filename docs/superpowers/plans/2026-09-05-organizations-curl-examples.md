# Organizations — curl walkthrough

Assumes the server is running locally on port 9000 (`npm run dev`) and you
have two logged-in users' access tokens (`$OWNER_TOKEN`, `$MEMBER_TOKEN`)
from `POST /api/v1/user/login`.

## Standalone path (unaffected by this feature)

```bash
curl -s -X POST http://localhost:9000/api/v1/match/create \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"teamAName":"Mumbai Indians","teamBName":"Chennai Super Kings","totalOvers":20}'
```

## Org-owned path

```bash
# 1. Create an organization (caller becomes owner)
curl -s -X POST http://localhost:9000/api/v1/organization \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Riverside Cricket Club"}'
# => note the returned "id" as $ORG_ID

# 2. Add a second scorer as a member (must already have an account)
curl -s -X POST http://localhost:9000/api/v1/organization/$ORG_ID/members \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"member@example.com"}'

# 3. Create a team directly under the org
curl -s -X POST http://localhost:9000/api/v1/organization/$ORG_ID/teams \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Riverside U19","shortName":"RU19"}'
# => note the returned "id" as $TEAM_ID

# 4. The member (not the owner) creates a match using the org's team
curl -s -X POST http://localhost:9000/api/v1/match/create \
  -H "Authorization: Bearer $MEMBER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"teamAId\":\"$TEAM_ID\",\"teamBName\":\"Visitors\",\"totalOvers\":20}"

# 5. The member can also view the org's team profile and past results
curl -s http://localhost:9000/api/v1/team/$TEAM_ID -H "Authorization: Bearer $MEMBER_TOKEN"
curl -s http://localhost:9000/api/v1/team/$TEAM_ID/matches -H "Authorization: Bearer $MEMBER_TOKEN"

# 6. GET /v1/team for the member now includes this org team alongside their own
curl -s http://localhost:9000/api/v1/team -H "Authorization: Bearer $MEMBER_TOKEN"

# 7. Attach an existing standalone team the owner made earlier to the org
curl -s -X PATCH http://localhost:9000/api/v1/team/$SOME_OTHER_TEAM_ID/organization \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"organizationId\":\"$ORG_ID\"}"

# 8. Detach it back to standalone
curl -s -X PATCH http://localhost:9000/api/v1/team/$SOME_OTHER_TEAM_ID/organization \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"organizationId":null}'

# 9. A member leaves voluntarily
curl -s -X DELETE http://localhost:9000/api/v1/organization/$ORG_ID/members/$MEMBER_USER_ID \
  -H "Authorization: Bearer $MEMBER_TOKEN"

# 10. The owner deletes the org — its remaining teams orphan back to standalone
curl -s -X DELETE http://localhost:9000/api/v1/organization/$ORG_ID \
  -H "Authorization: Bearer $OWNER_TOKEN"
```

## Notes from Phase 2 verification

- Full backend suite: 553/554 passing under `--maxWorkers=2` (removes
  `MongoMemoryReplSet` resource contention). All 61 organization-specific
  tests (models, access utility, all 8 endpoints, the match/team-profile
  widening) pass 100% reliably in isolation, run twice.
- Remaining full-suite flakiness (`bowlerNameCollision`,
  `careerStatsIntegration` under default parallelism; a worker-ordering-
  dependent flake in `translationAdminAccess`) is pre-existing and
  unrelated to this feature — none of it touches a file this plan modified,
  and each passes cleanly in isolation.
- No `lint` script exists in this repo's `package.json` — confirmed, not
  skipped silently.
