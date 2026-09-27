import catchAsync from '../utils/catchAsync.js';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Team } from '../models/team.model.js';
import { Match } from '../models/match.model.js';
import { Organization } from '../models/organization.model.js';
import { Tournament } from '../models/tournament.model.js';
import { canAccessTeam, canManageTeam, getMemberOrgIds, isRosterPlayer } from '../utils/organizationAccess.js';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, serializeMatchHistoryItems, findOrCreatePlayerRecord } from './match.controller.js';
import { Player, PLAYER_ROLES } from '../models/player.model.js';
import { uploadOnCloudinary } from '../utils/cloudinary.js';
import { discardStagedFile } from '../utils/discardStagedFile.js';
import { parseTeamFields } from '../utils/teamFields.js';
import { computeTeamStats } from '../utils/teamStats.js';
import { User } from '../models/user.model.js';
import { PlayerInvite } from '../models/playerInvite.model.js';
import { notifyUser } from '../utils/notify.js';

// Shared by getTeamProfile/getTeamMatches: both need the team to exist and
// belong to the caller before doing anything else. A Team is only ever
// attached to a Match by the scorer who owns it (see createMatch's
// resolveTeamSide), so this ownership check on the Team implies ownership of
// every Match that references it — no separate createdBy filter needed on
// the Match query below.
const findOwnedTeam = async (teamId, requesterId) => {
    const team = await Team.findOne({ _id: teamId, isDeleted: false });
    if (!team) {
        throw new ApiError(404, "TEAM_NOT_FOUND");
    }
    if (!(await canAccessTeam(team, requesterId))) {
        throw new ApiError(403, "TEAM_NOT_OWNED");
    }
    return team;
};

// A team's organization is populated here (name only — no endpoint needs
// its members/owner) so the response can carry {id, name} per docs/api.md,
// not the bare ObjectId Team.organization actually stores.
const toOrganizationSummary = (organization) =>
    organization ? { id: organization._id, name: organization.name } : null;

// The players on `teamId` with an unanswered invite, as string ids — one query
// per request, never per row. Accepted and declined invites are not "pending":
// an accepted one already reads as `isClaimed`, a declined one is just a
// named player again.
const findPendingInvitePlayerIds = async (teamId) => {
    const invites = await PlayerInvite.find({ team: teamId, status: 'pending' }, 'player');
    return new Set(invites.map((invite) => String(invite.player)));
};

// One roster row — shared by the profile's `roster`, add-player and edit-player
// so the shape lives in one place. `isCaptain`/`isViceCaptain` come from the
// team-level defaults, never from a match's own squad.
const toRosterRow = (player, team, pendingInvitePlayerIds = new Set()) => ({
    playerId: player._id,
    playerName: player.name,
    jerseyNumber: player.jerseyNumber ?? null,
    role: player.role,
    isCaptain: team.captainId?.equals?.(player._id) ?? false,
    isViceCaptain: team.viceCaptainId?.equals?.(player._id) ?? false,
    inviteStatus: pendingInvitePlayerIds.has(String(player._id)) ? 'pending' : null,
});

// Same ownership pattern as getCareerStats: a malformed teamId throws a raw
// Mongoose CastError from the query layer itself, which errorHandler already
// turns into 400 INVALID_ID (see invalidObjectIdCastError.test.js) — no
// manual ObjectId validation needed here.
const getTeamProfile = catchAsync(async (req, res) => {
    const { teamId } = req.params;

    const team = await findOwnedTeam(teamId, req.user._id);
    await team.populate('players');
    await team.populate('organization', 'name');

    // Computed per request rather than stored — see teamStats.js. Newest first
    // so `form` reads most-recent-result-first.
    const completedMatches = await Match.find(
        { $or: [{ teamA: teamId }, { teamB: teamId }], status: 'completed', isDeleted: false },
        'teamA teamB result'
    ).sort({ createdAt: -1 }).lean();

    const activeRoster = team.players.filter((player) => !player.isDeleted);
    const pendingInvitePlayerIds = await findPendingInvitePlayerIds(team._id);

    return res.status(200).json(new ApiResponse(200, {
        teamId: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        logoUrl: team.logoUrl ?? null,
        organization: toOrganizationSummary(team.organization),
        canManage: await canManageTeam(team, req.user._id),
        stats: computeTeamStats(team._id, completedMatches),
        // No feature currently soft-deletes a Player, but the roster
        // shouldn't surface one if that ever changes — same defensive
        // filter as every other isDeleted:false query in this codebase.
        // A leader whose Player was soft-deleted is no longer on the visible
        // roster, so it reads back as null rather than a dangling id.
        captainId: activeRoster.find((player) => team.captainId?.equals(player._id))?._id ?? null,
        viceCaptainId: activeRoster.find((player) => team.viceCaptainId?.equals(player._id))?._id ?? null,
        roster: activeRoster.map((player) => toRosterRow(player, team, pendingInvitePlayerIds)),
    }, req.t("TEAM_PROFILE_FETCHED")));
});

// Identical shape/validation to GET /v1/match/history (see getMatchHistory;
// the per-match serializer is shared, since the client parses both with one model)
// — an $or across the two per-side indexes (match.model.js) instead of a
// single createdBy filter, since a team can be either teamA or teamB. All
// statuses are shown, same as match history: no completed-only filter.
// `?status=` narrows the team's matches to one chip of the profile screen's
// filter row. `live` groups innings_break with live — both reopen the scoring
// console. Returns null for "no filter". A value that isn't one of these
// (including a repeated/array param or an empty string) is malformed.
const TEAM_MATCH_STATUS_GROUPS = {
    all: null,
    live: ['live', 'innings_break'],
    upcoming: ['upcoming'],
    completed: ['completed'],
};
const parseTeamMatchStatus = (raw) => {
    if (raw === undefined) return null;
    if (typeof raw !== 'string' || !Object.hasOwn(TEAM_MATCH_STATUS_GROUPS, raw)) {
        throw new ApiError(400, "INVALID_STATUS_FILTER", { params: { allowed: Object.keys(TEAM_MATCH_STATUS_GROUPS).join(', ') } });
    }
    return TEAM_MATCH_STATUS_GROUPS[raw];
};

const getTeamMatches = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    await findOwnedTeam(teamId, req.user._id);

    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || DEFAULT_HISTORY_LIMIT;

    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw new ApiError(400, "INVALID_PAGINATION", { params: { max: MAX_HISTORY_LIMIT } });
    }

    const statuses = parseTeamMatchStatus(req.query.status);

    const filter = { $or: [{ teamA: teamId }, { teamB: teamId }], isDeleted: false };
    if (statuses) filter.status = { $in: statuses };

    const [matches, total] = await Promise.all([
        Match.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Match.countDocuments(filter),
    ]);

    const items = await serializeMatchHistoryItems(matches);

    return res.status(200).json(new ApiResponse(200, {
        matches: items,
        page,
        limit,
        total,
    }, req.t("TEAM_MATCHES_FETCHED")));
});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `Team.name`'s own maxlength: a longer search can never match, so it is a
// malformed request rather than a search that happens to find nothing. Same
// validation shape as getMatchHistory's own `?q=` (match.controller.js) —
// duplicated rather than imported since that one is private to its file too.
const MAX_TEAM_SEARCH_LENGTH = 50;
const parseTeamSearchQuery = (raw) => {
    if (raw === undefined) return null;
    if (typeof raw !== 'string') {
        throw new ApiError(400, "INVALID_SEARCH_QUERY", { params: { max: MAX_TEAM_SEARCH_LENGTH } });
    }
    const query = raw.trim();
    if (query.length > MAX_TEAM_SEARCH_LENGTH) {
        throw new ApiError(400, "INVALID_SEARCH_QUERY", { params: { max: MAX_TEAM_SEARCH_LENGTH } });
    }
    return query || null;
};

// `?owner=mine` — created by the caller directly. `?owner=others` — visible
// only through organization membership, created by a different member (a
// teammate's team, e.g. one the caller might now face as an opponent).
// Omitted means no split, today's behavior.
const TEAM_OWNER_SCOPES = ['mine', 'others'];
const parseTeamOwnerScope = (raw) => {
    if (raw === undefined) return null;
    if (!TEAM_OWNER_SCOPES.includes(raw)) {
        throw new ApiError(400, "INVALID_TEAM_OWNER_FILTER", { params: { allowed: TEAM_OWNER_SCOPES.join(', ') } });
    }
    return raw;
};

// Powers the "reuse an existing team" picker on match creation — the
// scorer's own teams, so they can pass one back as teamAId/teamBId instead
// of typing a name that createMatch would otherwise treat as brand new.
// `?q=` narrows by name/shortName (case-insensitive substring); `page`/
// `limit` follow the same shape as getTeamMatches/getMatchHistory so a
// growing team list never comes back as one unbounded array.
const listMyTeams = catchAsync(async (req, res) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || DEFAULT_HISTORY_LIMIT;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw new ApiError(400, "INVALID_PAGINATION", { params: { max: MAX_HISTORY_LIMIT } });
    }
    const query = parseTeamSearchQuery(req.query.q);
    const ownerScope = parseTeamOwnerScope(req.query.owner);

    const orgIds = await getMemberOrgIds(req.user._id);
    const clauses = [
        { isDeleted: false },
        { $or: [{ createdBy: req.user._id }, { organization: { $in: orgIds } }] },
    ];
    if (query) {
        clauses.push({
            $or: [
                { name: new RegExp(escapeRegex(query), 'i') },
                { shortName: new RegExp(escapeRegex(query), 'i') },
            ],
        });
    }
    if (ownerScope === 'mine') {
        clauses.push({ createdBy: req.user._id });
    } else if (ownerScope === 'others') {
        clauses.push({ createdBy: { $ne: req.user._id } });
    }
    const filter = { $and: clauses };

    const [teams, total] = await Promise.all([
        Team.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('organization', 'name'),
        Team.countDocuments(filter),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        teams: teams.map((team) => ({
            id: team._id,
            name: team.name,
            shortName: team.shortName ?? null,
            logoUrl: team.logoUrl ?? null,
            organization: toOrganizationSummary(team.organization),
        })),
        page,
        limit,
        total,
    }, req.t("MY_TEAMS_FETCHED")));
});

// Teams the caller is on the roster of through a linked Player — the "Teams I
// play for" list. Teams the caller can already reach as creator or
// organization member are left out so nothing shows twice; those live in
// listMyTeams.
const listPlayingForTeams = catchAsync(async (req, res) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || DEFAULT_HISTORY_LIMIT;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw new ApiError(400, "INVALID_PAGINATION", { params: { max: MAX_HISTORY_LIMIT } });
    }

    const myPlayers = await Player.find({ linkedUserId: req.user._id, isDeleted: false }, 'name');
    const orgIds = await getMemberOrgIds(req.user._id);
    const filter = {
        isDeleted: false,
        players: { $in: myPlayers.map((player) => player._id) },
        createdBy: { $ne: req.user._id },
        organization: { $nin: orgIds },
    };

    const [teams, total] = await Promise.all([
        Team.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Team.countDocuments(filter),
    ]);

    const nameById = new Map(myPlayers.map((player) => [String(player._id), player.name]));
    return res.status(200).json(new ApiResponse(200, {
        teams: teams.map((team) => ({
            id: team._id,
            name: team.name,
            shortName: team.shortName ?? null,
            logoUrl: team.logoUrl ?? null,
            myPlayerName: nameById.get(String(team.players.find((id) => nameById.has(String(id))))) ?? null,
        })),
        page,
        limit,
        total,
    }, req.t("PLAYING_FOR_TEAMS_FETCHED")));
});

// Attach an existing standalone team to an organization the caller owns, or
// detach an org-owned team back to standalone. Detaching only ever needs
// team ownership; attaching additionally needs ownership of the target org.
const updateTeamOrganization = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    const team = await findOwnedTeam(teamId, req.user._id);

    const organizationId = req.body.organizationId ?? null;

    if (organizationId === null) {
        team.organization = null;
        await team.save();
        return res.status(200).json(new ApiResponse(200, {
            id: team._id,
            organization: null,
        }, req.t("TEAM_ORGANIZATION_UPDATED")));
    }

    if (team.organization != null) {
        throw new ApiError(409, "TEAM_ALREADY_IN_ORGANIZATION");
    }

    const org = await Organization.findOne({ _id: organizationId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!org.owner.equals(req.user._id)) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }

    team.organization = org._id;
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        organization: team.organization,
    }, req.t("TEAM_ORGANIZATION_UPDATED")));
});

// Same file-upload path as updateOrganizationLogo: `upload.single('file')`
// stages and validates (type/size), Cloudinary hosts it. The previous logo is
// left orphaned on Cloudinary, the same tradeoff updateProfile and
// updateOrganizationLogo already make. Ownership is findOwnedTeam's own rule
// (creator or org member), so anyone who can open the team profile can set
// its logo.
const updateTeamLogo = catchAsync(async (req, res) => {
    const { teamId } = req.params;

    let team;
    try {
        team = await findOwnedTeam(teamId, req.user._id);
    } catch (error) {
        await discardStagedFile(req.file);
        throw error;
    }

    if (!req.file) {
        throw new ApiError(400, "LOGO_REQUIRED");
    }

    const uploadResult = await uploadOnCloudinary(req.file.path);
    if (!uploadResult?.secure_url) {
        throw new ApiError(500, "LOGO_UPLOAD_FAILED");
    }

    team.logoUrl = uploadResult.secure_url;
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        logoUrl: team.logoUrl,
    }, req.t("TEAM_LOGO_UPDATED")));
});

// A standalone team the caller owns, created without playing a match first.
// Organization-owned teams go through POST /v1/organization/:orgId/teams
// instead; both validate through parseTeamFields.
const createTeam = catchAsync(async (req, res) => {
    const { name, shortName } = parseTeamFields(req.body);

    const team = await Team.create({
        name,
        shortName,
        createdBy: req.user._id,
        organization: null,
    });

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        logoUrl: null,
        organization: null,
    }, req.t("TEAM_CREATED")));
});

// Rename (and/or re-set the short name of) a team the caller manages —
// creator for a standalone team, organization owner for an org team. Reuses
// parseTeamFields as-is: the edit sheet always sends both fields (prefilled
// from the current profile), so there is no "omitted vs blank shortName"
// distinction to make on the wire that create doesn't already handle.
// `captainId`/`viceCaptainId` on PATCH /v1/team/:teamId. A key that is absent
// leaves that leader untouched, `null` clears it, anything else must be a
// roster member's id. Returns only the keys that were sent, and validates the
// resulting pair against the stored other leader so setting just one key still
// can't make the two the same player. Runs before any assignment, so a
// rejected leader also discards the rename sent alongside it.
const parseTeamLeaders = (body, team) => {
    const leaders = {};
    for (const key of ['captainId', 'viceCaptainId']) {
        if (!Object.hasOwn(body ?? {}, key)) continue;
        const value = body[key];
        if (value === null) {
            leaders[key] = null;
            continue;
        }
        if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) {
            throw new ApiError(400, "INVALID_PLAYER_ID");
        }
        if (!team.players.some((id) => String(id) === value)) {
            throw new ApiError(400, "TEAM_LEADER_NOT_ON_ROSTER");
        }
        leaders[key] = value;
    }

    const captain = 'captainId' in leaders ? leaders.captainId : team.captainId;
    const viceCaptain = 'viceCaptainId' in leaders ? leaders.viceCaptainId : team.viceCaptainId;
    if (captain && viceCaptain && String(captain) === String(viceCaptain)) {
        throw new ApiError(400, "TEAM_LEADERS_MUST_DIFFER");
    }
    return leaders;
};

const updateTeam = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    const team = await findOwnedTeam(teamId, req.user._id);
    if (!(await canManageTeam(team, req.user._id))) {
        throw new ApiError(403, "TEAM_NOT_MANAGEABLE");
    }

    const { name, shortName } = parseTeamFields(req.body);
    const leaders = parseTeamLeaders(req.body, team);
    team.name = name;
    team.shortName = shortName;
    Object.assign(team, leaders);
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
    }, req.t("TEAM_UPDATED")));
});

// Matches that count as "the team is in use" for delete — a completed or
// abandoned match never blocks it; that's exactly the case this feature
// exists for (retiring a team once its matches are done).
const TEAM_BLOCKING_MATCH_STATUSES = ['upcoming', 'live', 'innings_break'];

// Soft delete. Refused (409) rather than allowed-with-orphaning, unlike
// deleteOrganization's team-orphaning: a team mid-match or mid-tournament
// has live references a caller should resolve first, not silently break.
const deleteTeam = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    const team = await findOwnedTeam(teamId, req.user._id);
    if (!(await canManageTeam(team, req.user._id))) {
        throw new ApiError(403, "TEAM_NOT_MANAGEABLE");
    }

    const activeMatch = await Match.exists({
        $or: [{ teamA: team._id }, { teamB: team._id }],
        status: { $in: TEAM_BLOCKING_MATCH_STATUSES },
        isDeleted: false,
    });
    if (activeMatch) {
        throw new ApiError(409, "TEAM_IN_ACTIVE_MATCH");
    }

    const activeTournament = await Tournament.exists({
        'teams.team': team._id,
        isDeleted: false,
    });
    if (activeTournament) {
        throw new ApiError(409, "TEAM_IN_TOURNAMENT");
    }

    team.isDeleted = true;
    await team.save();

    return res.status(200).json(new ApiResponse(200, { id: team._id }, req.t("TEAM_DELETED")));
});

const MAX_PLAYER_NAME_LENGTH = 50;

// Role and jersey number for the roster endpoints. `undefined` and `null` both
// mean "not provided" (the client omits unset fields); anything else must be
// valid, so a bad value is a 400 rather than silently dropped. Same rules as
// PATCH /v1/player/:playerId.
const parseRosterPlayerFields = (body, { allowClear = false } = {}) => {
    const { role, jerseyNumber } = body ?? {};
    const fields = {};

    if (role !== undefined && role !== null) {
        const trimmedRole = typeof role === 'string' ? role.trim() : '';
        if (!PLAYER_ROLES.includes(trimmedRole)) {
            throw new ApiError(400, "INVALID_PLAYER_ROLE");
        }
        fields.role = trimmedRole;
    }

    // On the edit endpoint an explicit `null` removes the number (an omitted
    // key leaves it); add-player has nothing to remove, so null there just
    // means "not provided".
    if (allowClear && jerseyNumber === null) {
        fields.clearJerseyNumber = true;
    } else if (jerseyNumber !== undefined && jerseyNumber !== null) {
        const num = Number(jerseyNumber);
        if (typeof jerseyNumber === 'boolean' || jerseyNumber === '' || !Number.isInteger(num) || num < 0 || num > 999) {
            throw new ApiError(400, "INVALID_JERSEY_NUMBER");
        }
        fields.jerseyNumber = num;
    }

    return fields;
};

const findManageableTeam = async (teamId, requesterId) => {
    const team = await findOwnedTeam(teamId, requesterId);
    if (!(await canManageTeam(team, requesterId))) {
        throw new ApiError(403, "TEAM_NOT_MANAGEABLE");
    }
    return team;
};

// Resolves which Player an add-player request means: `playerId` names one of
// the caller's own players; otherwise `name` is resolved against the roster
// first (Player identity is scorer-scoped, so a rostered player may belong to
// another account — e.g. an org member who scored a match for the team — and
// the owner adding "Rahul" must not create a second Rahul next to it), then
// find-or-create by name.
const resolveRosterPlayer = async (team, body, requesterId) => {
    if (body?.playerId !== undefined && body?.playerId !== null) {
        const player = await Player.findOne({ _id: body.playerId, createdBy: requesterId, isDeleted: false });
        if (!player) {
            throw new ApiError(404, "PLAYER_NOT_FOUND");
        }
        return player;
    }

    const rawName = body?.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "TEAM_PLAYER_NAME_INVALID");
    }
    const rostered = await Player.findOne({
        _id: { $in: team.players },
        nameLower: name.toLowerCase(),
        isDeleted: false,
    });
    return rostered ?? findOrCreatePlayerRecord(name, requesterId);
};

// Add a player to the team's roster by `playerId` or by name. Player identity is scorer-scoped
// (`{createdBy, nameLower}`), so an existing name resolves to the same Player
// rather than duplicating — the per-match opposing-team collision rule
// (`rosterPlayer`) has no opposing side here and doesn't apply. 201 when the
// player is newly on the roster, 200 when already there.
const addTeamPlayer = catchAsync(async (req, res) => {
    const team = await findManageableTeam(req.params.teamId, req.user._id);

    // An existing player picked from the scorer's own list is added by id; a
    // typed name goes through the roster-first find-or-create below. Only the
    // scorer's own players qualify by id — another account's player reaches a
    // roster by name, through the roster-first resolution.
    // Fields are parsed before resolving so an invalid role/jersey 400s
    // without a find-or-create having already written a Player.
    const fields = parseRosterPlayerFields(req.body);
    const player = await resolveRosterPlayer(team, req.body, req.user._id);
    if (Object.keys(fields).length > 0) {
        Object.assign(player, fields);
        await player.save();
    }

    // Decided from the roster as loaded, not from updateOne's modifiedCount:
    // Team's timestamps bump `updatedAt` on every update, so modifiedCount is
    // 1 even when $addToSet added nothing.
    const wasOnRoster = team.players.some((id) => id.equals(player._id));
    await Team.updateOne({ _id: team._id }, { $addToSet: { players: player._id } });
    const refreshed = await Team.findById(team._id);

    const status = wasOnRoster ? 200 : 201;
    return res.status(status).json(new ApiResponse(status, toRosterRow(player, refreshed, await findPendingInvitePlayerIds(team._id)), req.t("TEAM_PLAYER_ADDED")));
});

// How many name variants ("Rahul Sharma", "Rahul Sharma (2)", ...) an invite
// tries before giving up.
const MAX_INVITE_NAME_ATTEMPTS = 20;

// The Player an invite is for. Player identity is scorer-scoped by name, but
// two different people can share a full name — so the natural Player
// ("Rahul Sharma") is only used when it is free for THIS invitee: unlinked
// with no pending invite to someone else, or already theirs. Otherwise the next
// numbered variant is tried, so each person gets a Player of their own and one
// person accepting can never strand another's invite on the same Player. A
// Player pending for the same invitee (another team, or a repeat) is reused.
const resolveInvitePlayer = async (team, invitee, scorerId) => {
    const baseName = invitee.fullName.trim();
    for (let attempt = 1; attempt <= MAX_INVITE_NAME_ATTEMPTS; attempt += 1) {
        const suffix = attempt === 1 ? '' : ` (${attempt})`;
        const name = `${baseName.slice(0, MAX_PLAYER_NAME_LENGTH - suffix.length)}${suffix}`;
        const player = await resolveRosterPlayer(team, { name }, scorerId);

        if (player.linkedUserId) {
            if (player.linkedUserId.equals(invitee._id)) return player;
            continue;
        }
        const rival = await PlayerInvite.exists({
            player: player._id,
            status: 'pending',
            invitedUser: { $ne: invitee._id },
        });
        if (!rival) return player;
    }
    throw new ApiError(409, "PLAYER_ALREADY_CLAIMED");
};

// Invite an existing app user onto the roster. The roster gets a normal,
// scorer-owned Player named after the person immediately; linking that Player
// to their account is theirs to accept (see player-invite accept), never set
// here — `Player.linkedUserId` is what your-turn pushes go to. Repeating an
// invite for someone with a pending one is a harmless 200 no-op.
const inviteTeamPlayer = catchAsync(async (req, res) => {
    const team = await findManageableTeam(req.params.teamId, req.user._id);

    const userId = req.body?.userId;
    if (typeof userId !== 'string' || userId === '') {
        throw new ApiError(400, "INVALID_ID");
    }
    if (userId === String(req.user._id)) {
        throw new ApiError(400, "CANNOT_INVITE_SELF");
    }
    // Same visibility rule as the email lookup: only an active, verified,
    // non-deleted account can be invited.
    const invitee = await User.findOne({ _id: userId, accountStatus: 'active', isDeleted: false, isEmailVerified: true });
    if (!invitee) {
        throw new ApiError(404, "USER_NOT_FOUND");
    }

    const player = await resolveInvitePlayer(team, invitee, req.user._id);

    await Team.updateOne({ _id: team._id }, { $addToSet: { players: player._id } });
    const refreshed = await Team.findById(team._id);
    const respond = (status, inviteId, inviteStatus) =>
        res.status(status).json(new ApiResponse(status, {
            inviteId,
            status: inviteStatus,
            player: toRosterRow(player, refreshed, inviteStatus === 'pending' ? new Set([String(player._id)]) : new Set()),
        }, req.t("PLAYER_INVITE_SENT")));

    // Already linked to this very person: nothing to ask, they are on the roster.
    if (player.linkedUserId) {
        return respond(200, null, 'accepted');
    }

    let created;
    try {
        created = await PlayerInvite.create({
            player: player._id,
            team: team._id,
            invitedUser: invitee._id,
            invitedBy: req.user._id,
        });
    } catch (err) {
        if (err.code !== 11000) throw err;
        const pending = await PlayerInvite.findOne({ team: team._id, invitedUser: invitee._id, status: 'pending' });
        return respond(200, pending._id, 'pending');
    }

    await notifyUser({
        recipientId: invitee._id,
        type: 'player_invite',
        titleKey: 'NOTIFICATION_PLAYER_INVITE_TITLE',
        bodyKey: 'NOTIFICATION_PLAYER_INVITE_BODY',
        params: { inviter: req.user.fullName, team: team.name },
        data: {
            type: 'player_invite',
            inviteId: String(created._id),
            teamId: String(team._id),
            teamName: team.name,
        },
    });

    return respond(201, created._id, 'pending');
});

// Edit a rostered player's role/jersey through the team, so an organization
// owner can manage a roster whose Players were created by another account —
// PATCH /v1/player/:playerId stays creator-only.
const updateTeamPlayer = catchAsync(async (req, res) => {
    const { teamId, playerId } = req.params;
    const team = await findManageableTeam(teamId, req.user._id);

    if (!team.players.some((id) => String(id) === String(playerId))) {
        throw new ApiError(404, "PLAYER_NOT_ON_TEAM");
    }
    const { clearJerseyNumber, ...fields } = parseRosterPlayerFields(req.body, { allowClear: true });

    const player = await Player.findOne({ _id: playerId, isDeleted: false });
    if (!player) {
        throw new ApiError(404, "PLAYER_NOT_ON_TEAM");
    }
    Object.assign(player, fields);
    if (clearJerseyNumber) player.jerseyNumber = undefined;
    await player.save();

    return res.status(200).json(new ApiResponse(200, toRosterRow(player, team, await findPendingInvitePlayerIds(team._id)), req.t("PLAYER_UPDATED")));
});

export { listPlayingForTeams, findOwnedTeam, inviteTeamPlayer, addTeamPlayer, updateTeamPlayer, getTeamProfile, getTeamMatches, listMyTeams, createTeam, updateTeam, deleteTeam, updateTeamOrganization, updateTeamLogo };
