import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Fixture } from '../models/fixture.model.js';
import { Tournament } from '../models/tournament.model.js';
import { findAccessibleTournament, findOwnedTournament } from './tournament.controller.js';
import { createMatchWithJoinCode } from './match.controller.js';
import { resolveToss } from '../utils/resolveToss.js';
import {
    buildRoundRobinRounds,
    buildLeagueRounds,
    buildKnockoutRound1,
    buildKnockoutNextRound,
} from '../utils/generateFixtures.js';
import { isTournamentComplete, decideFixtureOutcome } from '../utils/resolveFixtureOutcome.js';

const asString = (value) => (typeof value === 'string' ? value : '');

const MIN_TEAMS = { knockout: 2, round_robin: 3, league: 3 };

const populateFixtures = (fixtures) =>
    Fixture.populate(fixtures, [
        { path: 'teamA', select: 'name shortName' },
        { path: 'teamB', select: 'name shortName' },
        { path: 'winner', select: 'name' },
    ]);

// Exported so every fixture-returning endpoint renders a fixture the same
// way — one shape for "a fixture" across the whole feature.
export const serializeFixture = (fixture) => ({
    id: fixture._id,
    round: fixture.round,
    order: fixture.order,
    teamA: fixture.teamA ? { id: fixture.teamA._id, name: fixture.teamA.name, shortName: fixture.teamA.shortName ?? null } : null,
    teamB: fixture.teamB ? { id: fixture.teamB._id, name: fixture.teamB.name, shortName: fixture.teamB.shortName ?? null } : null,
    isBye: fixture.isBye,
    status: fixture.status,
    winner: fixture.winner ? { id: fixture.winner._id, name: fixture.winner.name } : null,
    matchId: fixture.match ?? null,
});

const slotsToDocs = (tournamentId, round, slots) =>
    slots.map((slot, order) => ({
        tournament: tournamentId,
        round,
        order,
        teamA: slot.teamA,
        teamB: slot.teamB,
        isBye: slot.isBye,
        status: slot.isBye ? 'bye' : 'scheduled',
        winner: slot.isBye ? slot.teamA : null,
    }));

// Checks the whole tournament's fixtures for completion and, if resolved,
// flips Tournament.status. Shared by three call sites: this controller's
// own "generate round 1 of a 2-team knockout" (which never touches a Match
// at all, so nothing else would ever check it), the match-completion hook
// (which passes `session` since it runs inside scoreBall's transaction),
// and the manual-resolve endpoint (no session, same as this one).
export const checkTournamentCompletion = async (tournament, { session } = {}) => {
    if (tournament.status === 'completed') return;
    const allFixtures = await Fixture.find({ tournament: tournament._id }, 'round status').session(session ?? null);
    if (isTournamentComplete(tournament.format, allFixtures)) {
        tournament.status = 'completed';
        await tournament.save({ session });
    }
};

export const generateFixtures = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    if (tournament.status === 'completed') {
        throw new ApiError(409, "TOURNAMENT_ALREADY_COMPLETE");
    }

    const existingFixtures = await Fixture.find({ tournament: tournament._id }).sort({ round: 1, order: 1 });

    if (existingFixtures.length === 0) {
        const minTeams = MIN_TEAMS[tournament.format];
        if (tournament.teams.length < minTeams) {
            throw new ApiError(400, "INSUFFICIENT_TEAMS_FOR_FORMAT");
        }

        const teamIds = tournament.teams.map((entry) => entry.team);
        const roundsOfSlots =
            tournament.format === 'knockout' ? [buildKnockoutRound1(teamIds)]
            : tournament.format === 'league' ? buildLeagueRounds(teamIds)
            : buildRoundRobinRounds(teamIds);

        const docs = roundsOfSlots.flatMap((slots, i) => slotsToDocs(tournament._id, i + 1, slots));
        await Fixture.insertMany(docs);

        const round1 = await Fixture.find({ tournament: tournament._id, round: 1 }).sort({ order: 1 });
        await populateFixtures(round1);

        return res.status(200).json(new ApiResponse(200, {
            tournamentId: tournament._id,
            round: 1,
            fixtures: round1.map(serializeFixture),
        }, req.t("FIXTURES_GENERATED")));
    }

    if (tournament.format !== 'knockout') {
        throw new ApiError(409, "FIXTURES_ALREADY_GENERATED");
    }

    const maxRound = Math.max(...existingFixtures.map((f) => f.round));
    const latestRound = existingFixtures.filter((f) => f.round === maxRound);

    // Order matters: a not-yet-played or tied/no-result final is still a
    // single-fixture round, so checking length before status would report
    // TOURNAMENT_ALREADY_COMPLETE for a final that hasn't actually resolved
    // yet. checkTournamentCompletion already flips Tournament.status the
    // moment the final's fixture reaches 'completed' (caught by this
    // function's own top-of-function status check above), so by the time
    // execution reaches here a lone final fixture is, by construction,
    // still scheduled or unresolved — length === 1 below is a defensive
    // fallback, not the expected path.
    if (latestRound.some((f) => f.status === 'scheduled' || f.status === 'unresolved')) {
        throw new ApiError(400, "ROUND_NOT_COMPLETE");
    }
    if (latestRound.length === 1) {
        throw new ApiError(409, "TOURNAMENT_ALREADY_COMPLETE");
    }

    const winnerIds = latestRound.map((f) => f.winner);
    const slots = buildKnockoutNextRound(winnerIds);
    const docs = slotsToDocs(tournament._id, maxRound + 1, slots);
    await Fixture.insertMany(docs);

    const nextRound = await Fixture.find({ tournament: tournament._id, round: maxRound + 1 }).sort({ order: 1 });
    await populateFixtures(nextRound);

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        round: maxRound + 1,
        fixtures: nextRound.map(serializeFixture),
    }, req.t("FIXTURES_GENERATED")));
});

export const listFixtures = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const fixtures = await Fixture.find({ tournament: tournament._id }).sort({ round: 1, order: 1 });
    await populateFixtures(fixtures);

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        fixtures: fixtures.map(serializeFixture),
    }, req.t("FIXTURES_FETCHED")));
});

const MIN_OVERS = 1;
const MAX_OVERS = 50;

export const startFixtureMatch = catchAsync(async (req, res) => {
    const { tournamentId, fixtureId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const fixture = await Fixture.findOne({ _id: fixtureId, tournament: tournament._id })
        .populate('teamA', 'name')
        .populate('teamB', 'name');
    if (!fixture) {
        throw new ApiError(404, "FIXTURE_NOT_FOUND");
    }
    if (fixture.isBye || fixture.status !== 'scheduled') {
        throw new ApiError(400, "FIXTURE_NOT_SCHEDULED");
    }
    if (fixture.match) {
        throw new ApiError(409, "FIXTURE_ALREADY_STARTED");
    }

    const { totalOvers, tossWinner, tossDecision } = req.body;
    if (!Number.isInteger(totalOvers) || totalOvers < MIN_OVERS || totalOvers > MAX_OVERS) {
        throw new ApiError(400, "INVALID_OVERS_FORMAT");
    }
    const toss = resolveToss({ tossWinner, tossDecision });
    if (!toss.valid) {
        throw new ApiError(400, "INVALID_TOSS_RESULT");
    }

    const match = await createMatchWithJoinCode({
        teamA: fixture.teamA._id,
        teamB: fixture.teamB._id,
        totalOvers,
        tossWinner: toss.tossWinner ?? undefined,
        tossDecision: toss.tossDecision ?? undefined,
        battingFirst: toss.battingFirst,
        createdBy: req.user._id,
        matchType: 'tournament',
        tournament: tournament._id,
        fixture: fixture._id,
    });

    // Atomic claim: a filter requiring `match: null` means a concurrent
    // second call loses the race here rather than both succeeding — the
    // Match this call already created is a harmless orphan in that case,
    // same tolerance this codebase already extends to an orphan Team/Player
    // from a losing findOneAndUpdate race elsewhere.
    const claimed = await Fixture.findOneAndUpdate(
        { _id: fixture._id, match: null },
        { $set: { match: match._id } }
    );
    if (!claimed) {
        throw new ApiError(409, "FIXTURE_ALREADY_STARTED");
    }

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        fixtureId: fixture._id,
        tournamentId: tournament._id,
        joinCode: match.joinCode,
        teamA: { id: fixture.teamA._id, name: fixture.teamA.name },
        teamB: { id: fixture.teamB._id, name: fixture.teamB.name },
        totalOvers: match.totalOvers,
        tossWinner: match.tossWinner ?? null,
        tossDecision: match.tossDecision ?? null,
        status: match.status,
        syncStatus: match.syncStatus,
        createdAt: match.createdAt,
    }, req.t("MATCH_CREATED")));
});

// Called once a Match tied to a fixture reaches a terminal state
// ('completed' with a result, or 'abandoned'). Shared by the scoreBall/
// syncMatch completion path (inside a transaction, via `session`) and
// abandonMatch (best-effort, no transaction — same tolerance this codebase
// already gives generateScorecard's own post-abandon call).
export const resolveFixtureAfterMatch = async (match, { session } = {}) => {
    if (!match.fixture) return;

    const fixture = await Fixture.findById(match.fixture).session(session ?? null);
    if (!fixture) return;

    const outcome = decideFixtureOutcome(fixture, match);
    if (!outcome) return;

    fixture.status = outcome.status;
    fixture.winner = outcome.winner;
    await fixture.save({ session });

    const tournament = await Tournament.findById(fixture.tournament).session(session ?? null);
    if (!tournament) return;
    await checkTournamentCompletion(tournament, { session });
};

export const resolveFixture = catchAsync(async (req, res) => {
    const { tournamentId, fixtureId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const fixture = await Fixture.findOne({ _id: fixtureId, tournament: tournament._id });
    if (!fixture) {
        throw new ApiError(404, "FIXTURE_NOT_FOUND");
    }
    if (fixture.status !== 'unresolved') {
        throw new ApiError(400, "FIXTURE_NOT_UNRESOLVED");
    }

    const winnerId = asString(req.body.winner).trim();
    if (!winnerId) {
        throw new ApiError(400, "FIXTURE_WINNER_REQUIRED");
    }
    if (!mongoose.Types.ObjectId.isValid(winnerId)) {
        throw new ApiError(400, "INVALID_ID");
    }
    if (![String(fixture.teamA), String(fixture.teamB)].includes(winnerId)) {
        throw new ApiError(400, "INVALID_FIXTURE_WINNER");
    }

    fixture.status = 'completed';
    fixture.winner = winnerId;
    await fixture.save();

    await checkTournamentCompletion(tournament);

    await fixture.populate('winner', 'name');
    return res.status(200).json(new ApiResponse(200, {
        fixtureId: fixture._id,
        status: fixture.status,
        winner: { id: fixture.winner._id, name: fixture.winner.name },
    }, req.t("FIXTURE_RESOLVED")));
});
