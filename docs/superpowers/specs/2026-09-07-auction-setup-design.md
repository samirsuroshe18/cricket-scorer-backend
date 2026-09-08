# Auction Setup — Design

**Status:** Approved, ready for implementation planning.
**Repos affected:** `cricket-scorer-backend` (this spec), `cricket-scrorer` (Flutter, same plan — this
feature is small enough for one phased plan spanning both, matching the delegated-scoring and
player-pool-registration precedent).
**Contract doc:** [docs/api.md](../../../docs/api.md) — the new `## Auction setup` subsection under
`## Tournament` is the finalized, binding version of everything below. This file is the reasoning; if
the two disagree, `docs/api.md` wins and this file is stale.
**Builds on:** [2026-09-07-player-pool-registration-design.md](2026-09-07-player-pool-registration-design.md)
— reuses its authority tier (`findOwnedTournament`/`findAccessibleTournament`), its
organizer-set-number-not-stats-derived rule for money fields, and `docs/roadmap.md`'s "Decisions settled
before Phase 4" section (play-money only; access control keyed on paid-Organization status).

## 1. Motivation

Phase 4's live auction needs a config surface before it needs a bid room: which of a tournament's
enrolled teams has a real person bidding for it, what budget they start with, and what squad shape the
tournament enforces (once something exists to enforce it against). This pass builds that surface —
organizer-facing setup only. It does not build the live room, budgets being spent, or any enforcement of
the rules configured here — see §11.

## 2. Two identity questions settled here, both flagged for brainstorming rather than assumed

**Can an auction "owner" be a name-only record, the way `Player` is?** No. `Player` has no link to
`User` by permanent design (see `docs/api.md`'s "Player has no link to User" note) precisely *because* a
`Player` is a passive record someone else describes — it never needs to log in or act. An owner is the
opposite: the live room (a later pass) expects them to actually place bids, which requires real
authentication. An owner must be a `User`.

**Which `User`s are eligible?** Existing members of the tournament's owning `Organization` — not an
arbitrary registered account reachable by email lookup. This mirrors delegated scoring's own assignee
rule exactly (`docs/superpowers/specs/2026-09-05-delegated-scoring-design.md` §Scope decision 4) and for
the same reasons: it reuses `Organization.members`/`isOrgMember` as-is, and keeps the owner pool inside
people the organizer already vetted into their club rather than inventing an invite-by-email flow this
app has no infrastructure for anywhere.

**Assignment is direct, not an invite/accept flow.** This app has no invite/notification infrastructure
today (the delegated-scoring spec made the identical call, explicitly, for the identical reason — see
its §11). The organizer picks an org member and sets their budget in one action, the same shape
`assignScorer` already uses. The roadmap's "invites" is organizer-facing product language, not a
two-party handshake this pass implements.

## 3. Scope decisions (from brainstorming)

1. **One owner per team, one team per owner, within a tournament.** A person bids for exactly one side.
   Enforced by two compound unique indexes (§5), not just application logic.
2. **Squad-composition rules are tournament-wide, not per-team.** They're a fairness rule across the
   whole auction, not an individual owner's preference — one `AuctionSettings` document per tournament.
3. **Category caps are included, because they're free.** `Player.role` already exists
   (`batsman`/`bowler`/`allrounder`/`wicketkeeper`/`unknown`) — a cap is an optional `{role: maxCount}`
   map over that existing enum, no new taxonomy invented. `unknown` is excluded from capping (nothing
   meaningful to cap). Had this required a new category concept from scratch, it would have been cut for
   this pass; reuse is the entire justification.
4. **All settings fields are optional and independently updatable**, mirroring `updateTournament`'s own
   `!== undefined`-per-field convention exactly (not a new partial-update variant). There is no
   explicit-null-clear for `minSquadSize`/`maxSquadSize`/`categoryCaps` in this pass, for the same reason
   `updateTournament` has none for its own scalar fields: once set, a value cannot be cleared back to
   "unset" through this endpoint. A real but minor gap — see §11.
5. **The `owners` array, when present in the request, fully replaces the current owner set** (an empty
   array clears every owner). When the key is absent from the request, existing owners are left
   untouched. This is what makes the endpoint safe to call for "just update squad rules" without
   accidentally wiping owner assignments — the two concerns are independent per-request, not coupled
   into an all-or-nothing PUT.
6. **No completeness/readiness gate.** Nothing in this pass checks "does every enrolled team have an
   owner" or "are squad rules set" — there is no "auction is ready to start" event yet for such a gate to
   serve, matching the player-pool spec's identical stance on withdrawal cutoffs.
7. **Budget, like base price, is a plain organizer-entered integer with no code path from
   `CareerStats`/`PlayerMatchStats`, anywhere, including as a suggestion.** Same reasoning as the
   player-pool spec's §4, restated here because it's the identical exploit shape: nothing about *who*
   the money field concerns (a player's price vs. an owner's budget) changes whether stats can be
   verified as belonging to a specific real person — they still can't, because `Player`↔`User` is still
   unlinked. Validation: whole number, `1`–`100000000`, same sanity bound as base price, same reasoning
   (organizer's own economy scale, not a business rule).
8. **Access control is `findOwnedTournament`/`findAccessibleTournament`, reused verbatim, behind one
   named seam for the future paid-tier check.** See §7.

## 4. Data model

Two new collections, both mirroring `PlayerPoolEntry`'s reasoning over embedding into `Tournament`: each
needs independent updates without re-saving an unrelated document, and — for `AuctionTeamOwner` — a
natural per-row identity a `Tournament.teams`-style embedded array doesn't need.

### `auctionSettings.model.js`

```js
import mongoose, { Schema } from "mongoose";
import { PLAYER_ROLES } from "./player.model.js";

// Category caps only apply to a real playing role — 'unknown' is excluded,
// the same way it's excluded from any role-based logic elsewhere: nothing
// meaningful to cap when the role itself is undetermined.
export const CATEGORY_CAP_ROLES = PLAYER_ROLES.filter((role) => role !== 'unknown');

const auctionSettingsSchema = new Schema(
  {
    tournament:   { type: Schema.Types.ObjectId, ref: 'Tournament', required: true, unique: true },
    minSquadSize: { type: Number, min: 1, max: 100 },
    maxSquadSize: { type: Number, min: 1, max: 100 },
    // Plain object keyed by a CATEGORY_CAP_ROLES member -> max count for
    // that role, e.g. {"wicketkeeper": 3}. Not a Mongoose Map: small,
    // fixed-key-space, always read/written whole rather than queried
    // per-key, so a plain object needs no extra ceremony.
    categoryCaps: { type: Schema.Types.Mixed },
    createdBy:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const AuctionSettings = mongoose.model('AuctionSettings', auctionSettingsSchema);
```

### `auctionTeamOwner.model.js`

```js
import mongoose, { Schema } from "mongoose";

const auctionTeamOwnerSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    team:       { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    owner:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Play-money only, per docs/roadmap.md's settled decision — a plain
    // organizer-entered integer, never derived from career stats. Same
    // reasoning as PlayerPoolEntry.basePrice; see this spec's §3.7.
    budget:     { type: Number, required: true, min: 1, max: 100000000 },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One owner per team...
auctionTeamOwnerSchema.index({ tournament: 1, team: 1 }, { unique: true });
// ...and one team per owner, within a tournament.
auctionTeamOwnerSchema.index({ tournament: 1, owner: 1 }, { unique: true });

export const AuctionTeamOwner = mongoose.model('AuctionTeamOwner', auctionTeamOwnerSchema);
```

No changes to `Player`, `Team`, `Tournament`, `Organization`, or `PlayerPoolEntry`'s own schemas.

## 5. Access control

```js
// The paid-tier half of the roadmap's settled auction-access-control
// decision — "does this auction's tournament belong to a paid
// Organization" — cannot be checked yet: `Organization` carries no
// tier/subscription field at all (Phase 6 is unbuilt). This seam is where
// that check attaches once it exists; today it is identical to
// findOwnedTournament/findAccessibleTournament. Not stubbed with a
// speculative field, per the player-pool spec's identical stance (§7 there).
const canConfigureAuction = (tournamentId, userId) => findOwnedTournament(tournamentId, userId);
const canViewAuctionSetup = (tournamentId, userId) => findAccessibleTournament(tournamentId, userId);
```

`PATCH .../auction-setup` → `canConfigureAuction` (org owner only, same tier as `addTournamentTeam`,
`registerPoolPlayer`). `GET .../auction-setup` → `canViewAuctionSetup` (any org member, same tier as
`getTournament`, `listPoolEntries`).

## 6. The endpoint, and why it needs a transaction

### `PATCH /v1/tournament/:tournamentId/auction-setup`

Each of `minSquadSize`, `maxSquadSize`, `categoryCaps`, and `owners` is applied only if present in the
request body (`!== undefined`), independently — the same convention `updateTournament` already uses.
`owners`, when present, **fully replaces** the current owner set (§3.5); omitted, existing owners are
untouched.

```js
const setAuctionSetup = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await canConfigureAuction(tournamentId, req.user._id);

    const settingsUpdate = {};
    if (req.body.minSquadSize !== undefined) {
        validateSquadSizeField(req.body.minSquadSize);
        settingsUpdate.minSquadSize = req.body.minSquadSize;
    }
    if (req.body.maxSquadSize !== undefined) {
        validateSquadSizeField(req.body.maxSquadSize);
        settingsUpdate.maxSquadSize = req.body.maxSquadSize;
    }
    // The cross-check must hold against the *effective* pair after this
    // update applies, not just the two fields present in this request —
    // otherwise a request that only lowers maxSquadSize (leaving an
    // already-stored, now-larger minSquadSize untouched) would sail through
    // and leave min > max stored. Only worth the extra read when either
    // field is actually changing.
    if (settingsUpdate.minSquadSize !== undefined || settingsUpdate.maxSquadSize !== undefined) {
        const existing = await AuctionSettings.findOne({ tournament: tournament._id });
        const effectiveMin = settingsUpdate.minSquadSize !== undefined
            ? settingsUpdate.minSquadSize : existing?.minSquadSize;
        const effectiveMax = settingsUpdate.maxSquadSize !== undefined
            ? settingsUpdate.maxSquadSize : existing?.maxSquadSize;
        if (effectiveMin != null && effectiveMax != null && effectiveMin > effectiveMax) {
            throw new ApiError(400, "INVALID_SQUAD_SIZE");
        }
    }
    if (req.body.categoryCaps !== undefined) {
        validateCategoryCaps(req.body.categoryCaps);
        settingsUpdate.categoryCaps = req.body.categoryCaps;
    }

    const ownersProvided = req.body.owners !== undefined;
    const resolvedOwners = ownersProvided
        ? await validateOwners(req.body.owners, tournament)
        : null;

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            if (Object.keys(settingsUpdate).length > 0) {
                settingsUpdate.createdBy = req.user._id;
                await AuctionSettings.findOneAndUpdate(
                    { tournament: tournament._id },
                    { $set: settingsUpdate },
                    { upsert: true, session }
                );
            }
            if (ownersProvided) {
                await AuctionTeamOwner.deleteMany({ tournament: tournament._id }, { session });
                if (resolvedOwners.length > 0) {
                    await AuctionTeamOwner.insertMany(
                        resolvedOwners.map((o) => ({
                            tournament: tournament._id, team: o.teamId, owner: o.userId,
                            budget: o.budget, createdBy: req.user._id,
                        })),
                        { session }
                    );
                }
            }
        });
    } finally {
        await session.endSession();
    }

    return res.status(200).json(
        new ApiResponse(200, await formatAuctionSetup(tournament._id), req.t("AUCTION_SETUP_SAVED"))
    );
});
```

**Why this is a genuine transaction, not a contrived one:** a request touching both squad rules and the
owners list writes to two collections; a request touching only `owners` still replaces a *set* of
documents (delete-then-insert) where a partial application — three of five owners inserted, then a
duplicate-owner rejection — would leave the auction in a corrupt, half-configured state worse than either
the old or the new state. The transaction is what makes "replace the whole owners list" atomic instead of
"maybe-partially replace it."

The three field-level validators, each throwing on the caller's behalf so the call sites above stay flat:

```js
const validateSquadSizeField = (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ApiError(400, "INVALID_SQUAD_SIZE");
    }
};

const validateBudgetField = (budget) => {
    if (budget === undefined || budget === null) {
        throw new ApiError(400, "BUDGET_REQUIRED");
    }
    if (!Number.isInteger(budget) || budget < 1 || budget > 100000000) {
        throw new ApiError(400, "INVALID_BUDGET");
    }
};

const validateCategoryCaps = (categoryCaps) => {
    if (categoryCaps === null || typeof categoryCaps !== 'object' || Array.isArray(categoryCaps)) {
        throw new ApiError(400, "INVALID_CATEGORY_CAP");
    }
    for (const [role, cap] of Object.entries(categoryCaps)) {
        if (!CATEGORY_CAP_ROLES.includes(role)) {
            throw new ApiError(400, "INVALID_CATEGORY_CAP");
        }
        if (!Number.isInteger(cap) || cap < 1 || cap > 100) {
            throw new ApiError(400, "INVALID_CATEGORY_CAP");
        }
    }
};
```

`validateOwners` — team must already be enrolled (`tournament.teams`); owner must be a member of the
tournament's own organization; no team or owner repeated within the same request (the compound unique
indexes are the storage-level backstop, not the primary UX — this validation is what turns a duplicate
into a specific 400 instead of a generic 500 from a caught `E11000`):

```js
const validateOwners = async (owners, tournament) => {
    if (!Array.isArray(owners)) {
        throw new ApiError(400, "INVALID_OWNERS_LIST");
    }

    const enrolledTeamIds = new Set(tournament.teams.map((t) => String(t.team)));
    const seenTeams = new Set();
    const seenOwnerIds = new Set();
    const resolved = [];

    for (const entry of owners) {
        const teamId = asString(entry?.teamId).trim();
        const userId = asString(entry?.userId).trim();

        if (!mongoose.Types.ObjectId.isValid(teamId) || !enrolledTeamIds.has(teamId)) {
            throw new ApiError(400, "AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT");
        }
        if (seenTeams.has(teamId)) {
            throw new ApiError(400, "AUCTION_SETUP_DUPLICATE_TEAM");
        }
        seenTeams.add(teamId);

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            throw new ApiError(400, "AUCTION_SETUP_INVALID_OWNER");
        }
        if (seenOwnerIds.has(userId)) {
            throw new ApiError(400, "AUCTION_SETUP_DUPLICATE_OWNER");
        }
        seenOwnerIds.add(userId);

        validateBudgetField(entry?.budget);
        resolved.push({ teamId, userId, budget: entry.budget });
    }

    if (resolved.length > 0) {
        const org = await Organization.findOne({ _id: tournament.organization, isDeleted: false });
        for (const { userId } of resolved) {
            if (!isOrgMember(org, userId)) {
                throw new ApiError(400, "AUCTION_SETUP_INVALID_OWNER");
            }
        }
    }

    return resolved;
};
```

### `GET /v1/tournament/:tournamentId/auction-setup`

Any org member. Returns the combined state — squad rules (each `null` until set) plus the current owner
list, names resolved for display:

```js
const formatAuctionSetup = async (tournamentId) => {
    const [settings, owners] = await Promise.all([
        AuctionSettings.findOne({ tournament: tournamentId }),
        AuctionTeamOwner.find({ tournament: tournamentId })
            .populate('team', 'name shortName')
            .populate('owner', 'fullName'),
    ]);

    return {
        tournamentId,
        minSquadSize: settings?.minSquadSize ?? null,
        maxSquadSize: settings?.maxSquadSize ?? null,
        categoryCaps: settings?.categoryCaps ?? null,
        owners: owners.map((o) => ({
            teamId: o.team._id, teamName: o.team.name,
            userId: o.owner._id, userName: o.owner.fullName,
            budget: o.budget,
        })),
    };
};
```

No owners registered yet returns `"owners": []`, not an error — same convention as the empty player pool.

## 7. New error codes

- `INVALID_SQUAD_SIZE` (400) — `minSquadSize`/`maxSquadSize` not a whole number in `1`–`100`, or
  `minSquadSize > maxSquadSize`.
- `INVALID_CATEGORY_CAP` (400) — `categoryCaps` isn't a plain object, has a key outside
  `CATEGORY_CAP_ROLES`, or a value that isn't a whole number in `1`–`100`.
- `INVALID_OWNERS_LIST` (400) — `owners` present but not an array.
- `AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT` (400) — a `teamId` in `owners` isn't enrolled in this
  tournament.
- `AUCTION_SETUP_DUPLICATE_TEAM` (400) — the same `teamId` appears twice in one request.
- `AUCTION_SETUP_INVALID_OWNER` (400) — a `userId` is malformed or isn't a member of the tournament's
  organization.
- `AUCTION_SETUP_DUPLICATE_OWNER` (400) — the same `userId` appears twice in one request.
- `BUDGET_REQUIRED` (400) — an owner entry's `budget` is missing.
- `INVALID_BUDGET` (400) — not a whole number in `1`–`100000000`.
- `AUCTION_SETUP_SAVED` / `AUCTION_SETUP_FETCHED` (success messages).

`TOURNAMENT_NOT_FOUND` (404), `TOURNAMENT_NOT_OWNED` (403), `NOT_ORG_MEMBER` (403) are reused verbatim
from `findOwnedTournament`/`findAccessibleTournament` — same codes every other tournament endpoint
already returns for the same conditions. All new keys ship in `src/locales/{en,hi,mr}/common.json`,
enforced by `tests/locales.test.js`.

## 8. Routes and the auth-allowlist test

Mounts on the existing `src/routes/tournament.routes.js` router, which already carries `verifyJwt` on
every route:
```js
router.route('/:tournamentId/auction-setup')
    .patch(verifyJwt, setAuctionSetup)
    .get(verifyJwt, getAuctionSetup);
```
No `tests/routes.auth.test.js` allowlist changes — neither route is public.

## 9. Testing scope (detail for the implementation plan)

New, TDD from scratch:

- `auctionSettings.model.js` — unique `{tournament}` constraint.
- `auctionTeamOwner.model.js` — unique `{tournament, team}` and `{tournament, owner}` constraints,
  independently provable (same team twice fails; same owner twice fails; same pair across two different
  tournaments succeeds).
- `setAuctionSetup`: org owner can set squad rules alone (owners untouched); org owner can set owners
  alone (rules untouched); setting both together persists both; `minSquadSize > maxSquadSize` fails
  `INVALID_SQUAD_SIZE`; a `categoryCaps` key outside the four capped roles fails `INVALID_CATEGORY_CAP`;
  an owners entry naming a team not enrolled in the tournament fails
  `AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT`; a duplicate team or owner within one request fails with the
  specific duplicate code; a `userId` who isn't an org member fails `AUCTION_SETUP_INVALID_OWNER`;
  submitting `"owners": []` clears every existing owner; a non-owner org member gets
  `TOURNAMENT_NOT_OWNED`; a non-member gets `NOT_ORG_MEMBER`; **the transaction rollback case** — a
  request with three valid owner entries and a fourth that fails validation leaves zero owners changed
  (not three), verified by re-fetching after the failed call.
- `getAuctionSetup`: any org member can read; returns `null` squad-rule fields and an empty owners array
  before anything is set; resolves team/owner names for display; a non-member gets `NOT_ORG_MEMBER`.
- **Regression, not new:** confirm `PlayerPoolEntry`, `Fixture`, and the rest of the tournament suite are
  unaffected — this feature reads `Tournament`/`Organization` and writes only the two new collections.

## 10. Frontend surface (scope for the same plan, Flutter side)

- An "Auction setup" entry point on the tournament detail screen, visible to any org member (read) with
  edit actions visible only to the owner — same visibility split the player-pool screen already
  established.
- A squad-rules form (min/max squad size, optional per-role cap fields reusing `PLAYER_ROLES`' existing
  display labels) that PATCHes only the fields actually touched.
- An owner-assignment list: one row per tournament-enrolled team, an org-member picker (reusing whatever
  member-list source `scorer-candidates`/organization-detail already expose) and a budget field per row;
  saving PATCHes the full `owners` array in one call.
- No changes to the scoring console, match creation, player pool screen, or any existing screen — this is
  a net-new tournament-detail surface only.

## 11. Explicitly out of scope for this spec

- **All live-auction/bid-room mechanics** — current-player-on-the-block, live bid ticker, countdown,
  sold/unsold resolution, server-authoritative bid acceptance, budget being spent or decremented.
- **Enforcing squad rules or category caps against anything.** This pass stores the configuration; the
  live bid room is where it would ever be checked against an actual roster.
- **A completeness/readiness gate** ("every enrolled team has an owner," "rules are set") — §3.6.
- **Clearing `minSquadSize`/`maxSquadSize`/`categoryCaps` back to unset once set** — §3.4. A real, minor
  gap: for this pass, replacing a squad-rule value requires a new value, not an explicit clear. Revisit
  if it turns out to matter in practice.
- **Owner-side discovery** — a `User` seeing "you own team X's auction" anywhere. Deferred to whenever
  the live bid room needs it, matching the player-pool spec's identical deferral for pool visibility.
- **Post-auction squad view, SOLD cards** — later Phase 4/5 roadmap items, not this slice.
- **Paid-Organization access-control enforcement** — §5; blocked on Phase 6 defining what "paid" means on
  an `Organization` document.
- **Any change to `Player`, `Team`, `Tournament`, `Organization`, or `PlayerPoolEntry`'s existing schemas
  or endpoints.**
