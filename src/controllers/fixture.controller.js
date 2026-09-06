import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Fixture } from '../models/fixture.model.js';
import { Tournament } from '../models/tournament.model.js';
import { findAccessibleTournament, findOwnedTournament } from './tournament.controller.js';
import {
    buildRoundRobinRounds,
    buildLeagueRounds,
    buildKnockoutRound1,
    buildKnockoutNextRound,
} from '../utils/generateFixtures.js';
import { isTournamentComplete } from '../utils/resolveFixtureOutcome.js';

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

    if (latestRound.length === 1) {
        throw new ApiError(409, "TOURNAMENT_ALREADY_COMPLETE");
    }
    if (latestRound.some((f) => f.status === 'scheduled' || f.status === 'unresolved')) {
        throw new ApiError(400, "ROUND_NOT_COMPLETE");
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
