import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { Team } from '../models/team.model.js';
import { Player } from '../models/player.model.js';
import { Inning } from '../models/inning.model.js';
import { Over } from '../models/over.model.js';
import { BallEvent } from '../models/ballEvent.model.js';
import { Scorecard } from '../models/scorecard.model.js';
import { formatOvers } from '../utils/formatOvers.js';
import { emitScoreUpdate, emitOverComplete, emitScoreUndo, emitMatchComplete, emitMatchAbandoned, buildBowlerState, buildInningsState } from '../sockets/match.socket.js';
import { resolveDelivery, EXTRA_TYPES, RUNS_FROM } from '../utils/resolveDelivery.js';
import { resolveUndo } from '../utils/resolveUndo.js';
import { resolveMatchResult } from '../utils/resolveMatchResult.js';
import { resolveToss } from '../utils/resolveToss.js';
import { resolveSyncDecision } from '../utils/resolveSync.js';
import { generateScorecard, liveStrikeFigures } from '../utils/scorecard.js';
import { generateJoinCode } from '../utils/joinCode.js';
import { findMatchByIdOrCode } from '../utils/matchLookup.js';
import { resolveBallOutcome, isSameBowler, LEGAL_DELIVERIES_PER_OVER } from '../utils/resolveOver.js';
import {
    resolveStrike,
    WICKET_TYPES,
    DISMISSED_BATSMEN,
    WICKET_TYPES_ON_NO_BALL,
    WICKET_TYPES_ON_WIDE,
    MAX_WICKETS,
    RUN_OUT,
} from '../utils/resolveStrike.js';

const MIN_OVERS = 1;
const MAX_OVERS = 50;
const MAX_RUNS_PER_BALL = 6;
const MAX_PLAYER_NAME_LENGTH = 50;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;

// Teams are match-scoped, not reused by name: Phase 1 is meant to be ad-hoc,
// per-match-only rosters (docs/roadmap.md), so two different real teams that
// happen to share a name — even for the same scorer, across two unrelated
// matches — must never end up sharing a Player pool. createMatch is Team's
// only call site, so every match unconditionally gets its own fresh Team
// documents; there is nothing to "find" here.
const createTeam = (name, createdBy) => Team.create({ name, createdBy });

// Unlike Team, Player still needs a real find-or-create: the same batsman or
// bowler is looked up by name repeatedly within one match's lifetime (every
// over's bowler selection, every incoming batsman), all correctly meant to
// resolve to the same Player document — teamId already scopes that lookup to
// one match's roster now that Team is always created fresh per match. Race-safe
// the same way findOrCreateTeam used to be: the unique {teamId, name} index on
// Player rejects the loser of two concurrent upserts with E11000, and the
// winner's document is already there to fetch. Called outside any transaction —
// a duplicate-key error aborts a transaction outright, so the retry could not
// run in-session. An orphan Player from a later failure is harmless, exactly as
// an orphan Team is in createMatch.
const findOrCreatePlayer = async (name, teamId, createdBy) => {
    try {
        return await Player.findOneAndUpdate(
            { teamId, name },
            { $setOnInsert: { name, teamId, createdBy } },
            { upsert: true, returnDocument: 'after' }
        );
    } catch (err) {
        if (err.code === 11000) {
            return Player.findOne({ teamId, name });
        }
        throw err;
    }
};

// Six characters over a 30-character alphabet is ~729 million codes, so a
// collision is vanishingly rare — but "vanishingly rare" is not "impossible",
// and the unique index on Match.joinCode is what makes retrying correct rather
// than hopeful. Same shape as findOrCreatePlayer's E11000 handling: let the
// database be the authority on uniqueness and react to what it says.
const JOIN_CODE_ATTEMPTS = 5;

const createMatchWithJoinCode = async (fields) => {
    for (let attempt = 1; attempt <= JOIN_CODE_ATTEMPTS; attempt += 1) {
        try {
            return await Match.create({ ...fields, joinCode: generateJoinCode() });
        } catch (err) {
            // Only a joinCode collision is worth retrying. Any other duplicate
            // key is a different problem and must not be swallowed by a loop
            // that silently tries again with a new code.
            const isJoinCodeCollision =
                err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'joinCode');

            if (!isJoinCodeCollision || attempt === JOIN_CODE_ATTEMPTS) throw err;
        }
    }
};

const createMatch = catchAsync(async (req, res) => {
    const { teamAName, teamBName, totalOvers, tossWinner, tossDecision } = req.body;

    if (!teamAName?.trim() || !teamBName?.trim()) {
        throw new ApiError(400, "TEAM_NAMES_REQUIRED");
    }

    const trimmedA = teamAName.trim();
    const trimmedB = teamBName.trim();

    if (trimmedA.toLowerCase() === trimmedB.toLowerCase()) {
        throw new ApiError(400, "TEAM_NAMES_MUST_DIFFER");
    }

    if (!Number.isInteger(totalOvers) || totalOvers < MIN_OVERS || totalOvers > MAX_OVERS) {
        throw new ApiError(400, "INVALID_OVERS_FORMAT");
    }

    const toss = resolveToss({ tossWinner, tossDecision });
    if (!toss.valid) {
        throw new ApiError(400, "INVALID_TOSS_RESULT");
    }

    const [teamA, teamB] = await Promise.all([
        createTeam(trimmedA, req.user._id),
        createTeam(trimmedB, req.user._id),
    ]);

    const match = await createMatchWithJoinCode({
        teamA: teamA._id,
        teamB: teamB._id,
        totalOvers,
        tossWinner: toss.tossWinner ?? undefined,
        tossDecision: toss.tossDecision ?? undefined,
        battingFirst: toss.battingFirst,
        createdBy: req.user._id,
    });

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        // The share code, returned here because this is the only moment the
        // scorer's client learns it — nothing else it calls reports one.
        joinCode: match.joinCode,
        teamA: { id: teamA._id, name: teamA.name },
        teamB: { id: teamB._id, name: teamB.name },
        totalOvers: match.totalOvers,
        tossWinner: match.tossWinner ?? null,
        tossDecision: match.tossDecision ?? null,
        status: match.status,
        syncStatus: match.syncStatus,
        createdAt: match.createdAt,
    }, req.t("MATCH_CREATED")));
});

// Explicit pick rather than spreading the Mongoose subdoc, which would leak internals.
const serializeExtras = (extras) => ({
    wides: extras?.wides ?? 0,
    noBalls: extras?.noBalls ?? 0,
    byes: extras?.byes ?? 0,
    legByes: extras?.legByes ?? 0,
});

// Explicit pick, same reasoning as serializeExtras. Async because it queries
// the innings' ball history for each batsman's own runs/balls faced — see
// liveStrikeFigures. `inningsId` is separate from `pair` because `pair` is
// sometimes an Inning document and sometimes a plain strike-shaped object
// from resolveStrike, and only the former happens to carry its own _id under
// the same name a caller could rely on.
const buildStrike = async (pair, inningsId) => {
    const base = {
        strikerId: pair?.strikerId ?? null,
        strikerName: pair?.strikerName ?? null,
        nonStrikerId: pair?.nonStrikerId ?? null,
        nonStrikerName: pair?.nonStrikerName ?? null,
    };
    const figures = await liveStrikeFigures(inningsId, base.strikerId, base.nonStrikerId);
    return { ...base, ...figures };
};

// A re-pick from an already-[buildStrike]-enriched object, never a new query
// — for a payload that wants the same 8 fields without `rotated`/
// `rotationReason` riding along. Kept separate from `buildStrike` itself so
// that distinction can never be blurred into an accidental second query.
const pickStrikeFields = (strike) => ({
    strikerId: strike?.strikerId ?? null,
    strikerName: strike?.strikerName ?? null,
    strikerRuns: strike?.strikerRuns ?? 0,
    strikerBalls: strike?.strikerBalls ?? 0,
    nonStrikerId: strike?.nonStrikerId ?? null,
    nonStrikerName: strike?.nonStrikerName ?? null,
    nonStrikerRuns: strike?.nonStrikerRuns ?? 0,
    nonStrikerBalls: strike?.nonStrikerBalls ?? 0,
});

// No bowler name is denormalized onto Over or Inning, unlike the batsmen: the
// pair has to be reported on every single delivery, whereas a bowler's name is
// only ever needed when an over ends or a client joins. One lookup per over is
// nowhere near the scoring hot path.
const playerNameById = async (id) => {
    if (!id) return null;
    const player = await Player.findById(id);
    return player?.name ?? null;
};

// Everything the response and the sockets need beyond the ball row itself: who
// is at the crease after it, what it did to the over and the innings, and
// whether a bowler is now owed.
//
// Derived from the ball's own record rather than from live state, so a freshly
// scored ball and an idempotent replay run through identical code and cannot
// drift. Both halves of the rotation rule are recovered exactly — the over
// ended iff this legal ball took it from 5 legal deliveries to 6, and the runs
// half is then the XOR complement of the stored strikeRotated.
const buildBallView = async (
    ballEvent,
    postPair,
    totalOvers,
    overDoc = null,
    inningsNumber = 1,
    target = null
) => {
    const outcome = resolveBallOutcome({
        isLegal: ballEvent.isLegal,
        isWicket: ballEvent.isWicket,
        // The ball's own stored split, not a re-derivation — teamRuns is what
        // resolveDelivery called it at scoring time (ballRuns + ballExtras),
        // and BallEvent.runs/.extras are exactly that pair already applied.
        teamRuns: ballEvent.runs + ballEvent.extras,
        preEventState: ballEvent.preEventState,
        totalOvers,
        inningsNumber,
        target,
    });

    const rotatedOnRuns = ballEvent.strikeRotated !== outcome.overComplete;

    const view = {
        outcome,
        strike: {
            ...(await buildStrike(postPair, ballEvent.inningsId)),
            rotated: ballEvent.strikeRotated,
            // Null both when nothing rotated and when both halves fired and
            // cancelled — `rotated` alone says whether the strike changed.
            rotationReason: rotatedOnRuns === outcome.overComplete
                ? null
                : (rotatedOnRuns ? 'odd_runs' : 'over_end'),
        },
        over: null,
        nextBowler: null,
    };

    if (!outcome.overComplete) return view;

    const over = overDoc ?? await Over.findById(ballEvent.overId);
    const bowlerName = await playerNameById(over?.bowlerId);

    view.over = {
        overNumber: ballEvent.overNumber,
        legalDeliveries: over?.legalDeliveries ?? LEGAL_DELIVERIES_PER_OVER,
        totalRuns: over?.totalRuns ?? 0,
        wickets: over?.wickets ?? 0,
        extras: serializeExtras(over?.extras),
        bowlerId: over?.bowlerId ?? null,
        bowlerName,
    };

    // Present iff a bowler is owed, so the client branches on presence instead
    // of recombining overComplete with inningsComplete. `excludedBowler*` is the
    // rule for the over about to start, deliberately separate from
    // `over.bowlerId`, which is a fact about the over just bowled.
    if (outcome.newBowlerRequired) {
        view.nextBowler = {
            excludedBowlerId: over?.bowlerId ?? null,
            excludedBowlerName: bowlerName,
        };
    }

    return view;
};

// The pair as it stood after this ball, rebuilt from the ball's own record.
// preEventState supplies the pair before the delivery; the dismissed and
// incoming players come off the ball itself, because a wicket puts someone at
// the crease who was not in that snapshot.
const strikeAfterBall = (ballEvent) => {
    const pre = ballEvent.preEventState;
    return resolveStrike({
        strikerId: pre.strikerId,
        strikerName: pre.strikerName,
        nonStrikerId: pre.nonStrikerId,
        nonStrikerName: pre.nonStrikerName,
        rotated: ballEvent.strikeRotated,
        dismissedId: ballEvent.isWicket ? ballEvent.dismissedPlayerId : null,
        incomingId: ballEvent.incomingBatsmanId ?? null,
        incomingName: ballEvent.incomingBatsmanName ?? null,
    });
};

// Explicit pick, same reasoning as serializeExtras. Null on an ordinary ball so
// the client can branch on presence rather than on a boolean plus five fields.
const buildWicket = (ballEvent) => {
    if (!ballEvent.isWicket) return null;
    return {
        type: ballEvent.wicketType,
        dismissedPlayerId: ballEvent.dismissedPlayerId ?? null,
        dismissedPlayerName: ballEvent.dismissedPlayerName ?? null,
        incomingBatsmanId: ballEvent.incomingBatsmanId ?? null,
        incomingBatsmanName: ballEvent.incomingBatsmanName ?? null,
    };
};

const applyExtrasBuckets = (target, buckets) => {
    target.wides += buckets.wides;
    target.noBalls += buckets.noBalls;
    target.byes += buckets.byes;
    target.legByes += buckets.legByes;
};

const buildBallResponse = (ballEvent, inning, view) => ({
    ballEventId: ballEvent._id,
    matchId: ballEvent.matchId,
    inningsId: ballEvent.inningsId,
    overNumber: ballEvent.overNumber,
    ballNumber: ballEvent.ballNumber,
    absoluteBallSeq: ballEvent.absoluteBallSeq,
    runs: ballEvent.runs,
    extras: ballEvent.extras,
    extraType: ballEvent.extraType,
    runsFrom: ballEvent.runsFrom,
    isLegal: ballEvent.isLegal,
    overComplete: view.outcome.overComplete,
    over: view.over,
    nextBowler: view.nextBowler,
    // Read off this ball rather than off Inning.status, so replaying an older
    // key reports whether THAT delivery ended the innings — not whether the
    // innings has ended by now.
    inningsComplete: view.outcome.inningsComplete,
    // Innings 2 ending IS match completion — there is no separate detector.
    // `inning` here is always the innings this ball belongs to, in both the
    // fresh-score and idempotent-replay paths, so this reports what THAT ball
    // did, same as inningsComplete above.
    matchComplete: view.outcome.inningsComplete && inning.inningsNumber === 2,
    wicket: buildWicket(ballEvent),
    strike: view.strike,
    // Null on innings 1. Same field startInnings already sends once; repeated
    // here so the console's own required-run-rate stays correct without
    // having cached that first response.
    target: inning.target ?? null,
    inningsTotals: {
        totalRuns: inning.totalRuns,
        wickets: inning.wickets,
        legalBalls: inning.legalBalls,
        totalBalls: inning.totalBalls,
        oversCompleted: inning.oversCompleted,
        extras: serializeExtras(inning.extras),
    },
});

const buildLiveScorePayload = (ballEvent, inning, view) => ({
    matchId: ballEvent.matchId,
    inningsId: ballEvent.inningsId,
    inningsNumber: inning.inningsNumber,
    totalRuns: inning.totalRuns,
    wickets: inning.wickets,
    overs: formatOvers(inning.oversCompleted, inning.legalBalls),
    // Null on innings 1. Carried on every delivery, not just at join, so a
    // connection open through the innings-2 transition learns it without
    // reconnecting.
    target: inning.target ?? null,
    extras: serializeExtras(inning.extras),
    strike: view.strike,
    lastBall: {
        runs: ballEvent.runs,
        extras: ballEvent.extras,
        extraType: ballEvent.extraType,
        runsFrom: ballEvent.runsFrom,
        isLegal: ballEvent.isLegal,
        overNumber: ballEvent.overNumber,
        ballNumber: ballEvent.ballNumber,
        absoluteBallSeq: ballEvent.absoluteBallSeq,
        wicket: buildWicket(ballEvent),
    },
});

const buildOverCompletePayload = (ballEvent, inning, view) => ({
    matchId: ballEvent.matchId,
    inningsId: ballEvent.inningsId,
    inningsNumber: inning.inningsNumber,
    overNumber: view.over.overNumber,
    over: {
        totalRuns: view.over.totalRuns,
        wickets: view.over.wickets,
        legalDeliveries: view.over.legalDeliveries,
        extras: view.over.extras,
        bowlerId: view.over.bowlerId,
        bowlerName: view.over.bowlerName,
    },
    // The pair for the first ball of the next over. Deliberately without
    // rotated/rotationReason: rotation is a property of a delivery and belongs
    // to score:update; this event reports a state. `view.strike` is already
    // buildStrike-enriched — this re-picks rather than re-querying.
    strike: pickStrikeFields(view.strike),
    inningsComplete: view.outcome.inningsComplete,
    newBowlerRequired: view.outcome.newBowlerRequired,
});

// score:update first, then the over card — a spectator applies the delivery
// before being told the over it belongs to has ended.
const emitBallEvents = (req, ballEvent, inning, view) => {
    const io = req.app.get('io');
    if (!io) return;

    emitScoreUpdate(io, buildLiveScorePayload(ballEvent, inning, view));

    if (view.outcome.overComplete) {
        emitOverComplete(io, buildOverCompletePayload(ballEvent, inning, view));
    }
};

const respondWithExistingBall = async (match, idempotencyKey, res, req) => {
    const existing = await BallEvent.findOne({ matchId: match._id, idempotencyKey });
    if (!existing) return null;
    const inning = await Inning.findById(existing.inningsId);

    const view = await buildBallView(
        existing,
        strikeAfterBall(existing),
        match.totalOvers,
        null,
        inning.inningsNumber,
        inning.target
    );

    emitBallEvents(req, existing, inning, view);

    return res.status(200).json(new ApiResponse(200, buildBallResponse(existing, inning, view), req.t("BALL_SCORED")));
};

// Openers are chosen here rather than lazily on the first delivery, so the
// scoring console always knows who is facing before a ball is scored and the
// server is the only thing that ever decides strike.
//
// The opening bowler rides along for the same reason: score-ball refuses a
// delivery with no bowler set, so naming him here is what keeps "you can score
// ball 1 straight after start-innings" true. Every later over's bowler comes
// from selectBowler, which also enforces the consecutive-over rule — a rule
// that cannot apply to over 1, since there is no previous over.
const startInnings = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { strikerName, nonStrikerName, bowlerName } = req.body;

    if (!strikerName?.trim() || !nonStrikerName?.trim()) {
        throw new ApiError(400, "OPENER_NAMES_REQUIRED");
    }

    const striker = strikerName.trim();
    const nonStriker = nonStrikerName.trim();

    if (striker.length > MAX_PLAYER_NAME_LENGTH || nonStriker.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "OPENER_NAMES_REQUIRED");
    }

    if (striker.toLowerCase() === nonStriker.toLowerCase()) {
        throw new ApiError(400, "OPENER_NAMES_MUST_DIFFER");
    }

    const bowler = bowlerName?.trim();

    if (!bowler || bowler.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "BOWLER_NAME_REQUIRED");
    }

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (match.status === 'completed' || match.status === 'abandoned') {
        throw new ApiError(400, "MATCH_ALREADY_COMPLETED");
    }

    const existing = await Inning.findOne({ matchId: match._id, inningsNumber: match.currentInnings });

    // Re-callable until the first delivery lands, so a mis-tapped opener is just
    // another call. `totalBalls` is the innings' own count of deliveries, so this
    // needs no extra query.
    if (existing && existing.totalBalls > 0) {
        throw new ApiError(400, "INNINGS_ALREADY_STARTED");
    }

    // Innings 2 bats the side that bowled in innings 1 — the opposite of
    // battingFirst, not a re-derivation of it. This was unreachable before the
    // innings transition existed (currentInnings could only ever be 1), so the
    // bug of always resolving battingFirst regardless of which innings this is
    // had nothing to expose it until now.
    const firstBattingTeam = match.battingFirst || 'teamA';
    const battingTeam = match.currentInnings === 2
        ? (firstBattingTeam === 'teamA' ? 'teamB' : 'teamA')
        : firstBattingTeam;
    const bowlingTeam = battingTeam === 'teamA' ? 'teamB' : 'teamA';
    const battingTeamId = battingTeam === 'teamA' ? match.teamA : match.teamB;
    const bowlingTeamId = bowlingTeam === 'teamA' ? match.teamA : match.teamB;

    const [strikerDoc, nonStrikerDoc, bowlerDoc] = await Promise.all([
        findOrCreatePlayer(striker, battingTeamId, req.user._id),
        findOrCreatePlayer(nonStriker, battingTeamId, req.user._id),
        // Against the BOWLING side, so a name shared with a batsman is a
        // different Player document — which is what the {teamId, name} unique
        // index already implies.
        findOrCreatePlayer(bowler, bowlingTeamId, req.user._id),
    ]);

    const session = await mongoose.startSession();
    try {
        let inning;

        await session.withTransaction(async () => {
            const openers = {
                strikerId: strikerDoc._id,
                strikerName: strikerDoc.name,
                nonStrikerId: nonStrikerDoc._id,
                nonStrikerName: nonStrikerDoc.name,
                currentBowlerId: bowlerDoc._id,
            };

            if (existing) {
                inning = await Inning.findById(existing._id).session(session);
                Object.assign(inning, openers);
                await inning.save({ session });
            } else {
                const fields = {
                    matchId: match._id,
                    inningsNumber: match.currentInnings,
                    battingTeam,
                    bowlingTeam,
                    ...openers,
                };

                // Only innings 2 chases a target, and only once innings 1 has
                // actually finished — which, by the time currentInnings can
                // be 2 at all, it always has (see the innings transition in
                // score-ball). One more than what was defended, not what was
                // scored: conceding exactly the target ties, so the batting
                // side must pass it, not just match it.
                if (match.currentInnings === 2) {
                    const inning1 = await Inning.findOne({
                        matchId: match._id,
                        inningsNumber: 1,
                    }).session(session);
                    fields.target = inning1.totalRuns + 1;
                }

                [inning] = await Inning.create([fields], { session });
            }

            if (match.status === 'upcoming' || match.status === 'innings_break') {
                match.status = 'live';
                await match.save({ session });
            }
        });

        return res.status(200).json(new ApiResponse(200, {
            matchId: match._id,
            inningsId: inning._id,
            inningsNumber: inning.inningsNumber,
            battingTeam: inning.battingTeam,
            bowlingTeam: inning.bowlingTeam,
            // Null for innings 1 — nothing to chase yet. Set once, at
            // creation, from innings 1's completed total; never innings 2.
            target: inning.target ?? null,
            strike: await buildStrike(inning, inning._id),
            bowler: {
                bowlerId: bowlerDoc._id,
                bowlerName: bowlerDoc.name,
            },
            inningsTotals: {
                totalRuns: inning.totalRuns,
                wickets: inning.wickets,
                legalBalls: inning.legalBalls,
                totalBalls: inning.totalBalls,
                oversCompleted: inning.oversCompleted,
                extras: serializeExtras(inning.extras),
            },
        }, req.t("INNINGS_STARTED")));
    } finally {
        await session.endSession();
    }
});

// Pure, stateless shape checks for a bowler selection — shared by selectBowler
// (called before the match/inning load, so its error precedence is unchanged)
// and by a sync batch's per-event validation (see applySyncBallOrBowlerEvent).
const validateBowlerInput = (body) => {
    const name = body.bowlerName?.trim();

    if (!name || name.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "BOWLER_NAME_REQUIRED");
    }

    return { bowlerName: name };
};

// Names the bowler for the over that has not started yet, against an
// already-loaded `inning`. Shared by selectBowler (session: null — a single-
// document write needs no transaction) and by a sync batch, where it runs
// session-scoped alongside whatever deliveries surround it in the same
// transaction. Mutates and saves `inning` in place; the caller decides what
// else, if anything, needs saving in the same round trip.
const applyBowlerSelection = async ({ match, inning, session, req, bowlerName }) => {
    if (inning.status === 'completed') {
        throw new ApiError(400, "INNINGS_COMPLETED");
    }

    const overNumber = inning.oversCompleted + 1;

    // Asking BallEvent rather than reading Over.legalDeliveries is deliberate:
    // a wide as the first ball of the over leaves that counter at 0, but the
    // over has certainly begun.
    const started = await BallEvent.exists({ inningsId: inning._id, overNumber }).session(session);

    if (started) {
        throw new ApiError(400, "OVER_ALREADY_STARTED");
    }

    // Law 17.6, enforced here rather than left to the picker: an offline queue
    // replaying out of order, a second scorer, or a curl call all reach this
    // function without passing through any UI. The previous over's bowler is
    // read off Over.bowlerId — the permanent record — rather than tracked as a
    // second field on Inning that could drift from it.
    const previousOver = inning.oversCompleted > 0
        ? await Over.findOne({ inningsId: inning._id, overNumber: inning.oversCompleted }).session(session)
        : null;

    const previousBowlerId = previousOver?.bowlerId ?? null;
    const bowlingTeamId = inning.bowlingTeam === 'teamA' ? match.teamA : match.teamB;

    // Find-or-create runs outside the transaction's atomicity (no `{session}`
    // passed to it), same as everywhere else it is called — safe to repeat if
    // `session.withTransaction` retries this callback, since it always
    // resolves to the same document after the first call.
    const bowler = await findOrCreatePlayer(bowlerName, bowlingTeamId, req.user._id);

    if (isSameBowler(previousBowlerId, bowler._id)) {
        throw new ApiError(400, "BOWLER_CANNOT_BOWL_CONSECUTIVE_OVERS");
    }

    // A conditional write, not a plain `inning.save()`: two near-simultaneous
    // selectBowler calls for the same over both pass every check above off the
    // same stale read, and an unconditional save would let whichever landed
    // last silently overwrite the other — both callers getting a 200 with
    // their own choice echoed back, even though only one was ever true in the
    // database. Matching on `currentBowlerId` as it stood when this call
    // started makes the write a compare-and-swap: the loser's filter no
    // longer matches once the winner has committed, so it gets a real error
    // instead of a false success.
    const updated = await Inning.findOneAndUpdate(
        { _id: inning._id, currentBowlerId: inning.currentBowlerId },
        { $set: { currentBowlerId: bowler._id } },
        { session, returnDocument: 'after' }
    );

    if (!updated) {
        throw new ApiError(409, "BOWLER_SELECTION_CONFLICT");
    }

    inning.currentBowlerId = bowler._id;

    return { bowler, previousBowlerId, overNumber };
};

// A single-document write, so no transaction needed: applyBowlerSelection's
// compare-and-swap on `currentBowlerId` is what makes the write itself safe
// under a race, rather than a transaction around it.
const selectBowler = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { bowlerName } = validateBowlerInput(req.body);

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (match.status === 'completed' || match.status === 'abandoned') {
        throw new ApiError(400, "MATCH_ALREADY_COMPLETED");
    }

    const inning = await Inning.findOne({ matchId: match._id, inningsNumber: match.currentInnings });

    if (!inning) {
        throw new ApiError(400, "INNINGS_NOT_STARTED");
    }

    const { bowler, previousBowlerId, overNumber } = await applyBowlerSelection({
        match,
        inning,
        session: null,
        req,
        bowlerName,
    });

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        inningsId: inning._id,
        overNumber,
        bowler: {
            bowlerId: bowler._id,
            bowlerName: bowler.name,
        },
        // Echoed so a picker re-opened after a rejection can exclude the right
        // person without a second call. Null for over 1 of an innings.
        previousBowler: previousBowlerId
            ? {
                bowlerId: previousBowlerId,
                bowlerName: await playerNameById(previousBowlerId),
            }
            : null,
    }, req.t("BOWLER_SELECTED")));
});

// Pure, stateless shape checks for one delivery — every rule here is a fact
// about the request body alone, independent of match/innings state. Shared by
// scoreBall (called before the match load, so its error precedence is
// unchanged) and by a sync batch's per-event validation, where a failure here
// stops the batch at that event rather than rejecting the whole request — see
// syncMatch.
const validateBallInput = (body) => {
    const { runs, idempotencyKey } = body;

    if (!Number.isInteger(runs) || runs < 0 || runs > MAX_RUNS_PER_BALL) {
        throw new ApiError(400, "RUNS_OUT_OF_RANGE");
    }

    if (!idempotencyKey?.trim()) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
    }

    // `extraType` is the delivery fault (wide/no_ball); `runsFrom` is who the runs
    // belong to (bat/bye/leg_bye). Independent — a no-ball can also go for byes.
    const extraType = body.extraType ?? null;
    const runsFrom = body.runsFrom ?? 'bat';

    if (extraType !== null && !EXTRA_TYPES.includes(extraType)) {
        throw new ApiError(400, "INVALID_EXTRA_TYPE");
    }

    if (!RUNS_FROM.includes(runsFrom)) {
        throw new ApiError(400, "INVALID_RUNS_FROM");
    }

    // Law 22: every run off a wide is debited as a wide, so attributing them to
    // byes/leg-byes is meaningless — reject it rather than silently ignoring.
    if (extraType === 'wide' && runsFrom !== 'bat') {
        throw new ApiError(400, "RUNS_FROM_NOT_ALLOWED_FOR_WIDE");
    }

    // `wicketType` mirrors `extraType` — presence, not a separate boolean, is
    // what marks the delivery a dismissal.
    const wicketType = body.wicketType ?? null;
    const dismissedBatsman = body.dismissedBatsman ?? 'striker';
    const incomingBatsmanName = body.incomingBatsmanName;

    if (wicketType !== null && !WICKET_TYPES.includes(wicketType)) {
        throw new ApiError(400, "INVALID_WICKET_TYPE");
    }

    if (!DISMISSED_BATSMEN.includes(dismissedBatsman)) {
        throw new ApiError(400, "INVALID_DISMISSED_BATSMAN");
    }

    if (wicketType) {
        // Only a run out can take the batsman at the bowler's end.
        if (dismissedBatsman === 'non_striker' && wicketType !== RUN_OUT) {
            throw new ApiError(400, "DISMISSED_BATSMAN_NOT_ALLOWED");
        }

        // Runs completed before a run out count; nothing is scored off a ball
        // you were bowled, caught, trapped or stumped off.
        if (wicketType !== RUN_OUT && runs > 0) {
            throw new ApiError(400, "RUNS_NOT_ALLOWED_WITH_WICKET");
        }

        // Laws 21 and 22 — see the wicket table in docs/api.md.
        if (extraType === 'no_ball' && !WICKET_TYPES_ON_NO_BALL.includes(wicketType)) {
            throw new ApiError(400, "WICKET_NOT_ALLOWED_ON_NO_BALL");
        }

        if (extraType === 'wide' && !WICKET_TYPES_ON_WIDE.includes(wicketType)) {
            throw new ApiError(400, "WICKET_NOT_ALLOWED_ON_WIDE");
        }
    }

    // idempotencyKey is deliberately NOT trimmed before being returned — it is
    // stored verbatim, exactly as it always has been, so a key that differs
    // only by whitespace is a different key rather than silently normalized.
    return { runs, idempotencyKey, extraType, runsFrom, wicketType, dismissedBatsman, incomingBatsmanName };
};

// Applies one already-validated delivery against an already-loaded, session-
// bound `inning` — the entire per-ball write scoreBall used to do inline,
// factored out so a sync batch can call it once per queued ball inside one
// shared transaction. Mutates and saves `inning` (and `match`, if this ball
// completes an innings) in place; returns the new BallEvent/Over alongside it
// so the caller can build a view or a socket payload without a re-read.
//
// Every state check here (INNINGS_COMPLETED, BOWLER_NOT_SELECTED, the
// incoming-batsman rules) reads `inning` as it stands AT THIS CALL — which,
// inside a sync batch, is however the previous events in the same batch left
// it. That is what lets a `bowler` event earlier in the batch satisfy
// BOWLER_NOT_SELECTED for a `ball` event later in it, and what makes an
// innings that completes mid-batch correctly refuse everything queued after.
const applyDelivery = async ({ match, inning, session, req, delivery }) => {
    const { runs, extraType, runsFrom, wicketType, dismissedBatsman, incomingBatsmanName, idempotencyKey } = delivery;

    // Re-checked here rather than trusted from an earlier read: for scoreBall
    // this IS the in-session re-check the old inline code did; for a sync
    // batch, this is the only check there is.
    if (inning.status === 'completed') {
        throw new ApiError(400, "INNINGS_COMPLETED");
    }

    // Nothing can be attributed to a null bowler, so the delivery is refused
    // rather than stored without one — which is what makes "a new bowler must
    // be selected" a rule and not a suggestion.
    if (!inning.currentBowlerId) {
        throw new ApiError(400, "BOWLER_NOT_SELECTED");
    }

    let incomingPlayer = null;

    if (wicketType) {
        const isFinalWicket = inning.wickets + 1 >= MAX_WICKETS;
        const trimmedIncoming = incomingBatsmanName?.trim();

        if (!isFinalWicket && !trimmedIncoming) {
            throw new ApiError(400, "INCOMING_BATSMAN_REQUIRED");
        }

        // On the final wicket nobody is left to come in, so a name sent anyway
        // is ignored rather than rejected — the caller has nothing useful to
        // do with an error there.
        if (!isFinalWicket) {
            const atCrease = [inning.strikerName, inning.nonStrikerName]
                .filter(Boolean)
                .map((name) => name.toLowerCase());

            if (atCrease.includes(trimmedIncoming.toLowerCase())) {
                throw new ApiError(400, "INCOMING_BATSMAN_AT_CREASE");
            }

            // A dismissed batsman can never legally bat again in this innings,
            // so a name matching one — even though they're long off the
            // crease — is never "the same player back again": it's either a
            // typo or a second real player who happens to share a name.
            // Checked against BallEvent rather than a cached list because
            // dismissedPlayerName already carries exactly this history, and an
            // undone wicket's deleted row automatically frees the name back up.
            const dismissedEarlier = await BallEvent.find({
                inningsId: inning._id,
                isWicket: true,
                dismissedPlayerName: { $ne: null },
            }, 'dismissedPlayerName').session(session);

            const alreadyBatted = dismissedEarlier
                .map((event) => event.dismissedPlayerName.toLowerCase());

            if (alreadyBatted.includes(trimmedIncoming.toLowerCase())) {
                throw new ApiError(400, "INCOMING_BATSMAN_NAME_REUSED");
            }

            const battingTeamId = inning.battingTeam === 'teamA' ? match.teamA : match.teamB;

            // Outside the transaction's atomicity on purpose, same as
            // applyBowlerSelection's find-or-create — see that function's
            // comment. An orphan Player from a delivery that fails later in
            // this same call is harmless, exactly as elsewhere in this file.
            incomingPlayer = await findOrCreatePlayer(trimmedIncoming, battingTeamId, req.user._id);
        }
    }

    const overNumber = inning.oversCompleted + 1;
    let over = await Over.findOne({ inningsId: inning._id, overNumber }).session(session);
    if (!over) {
        [over] = await Over.create([{
            matchId: match._id,
            inningsId: inning._id,
            overNumber,
            // Stamped once, at creation, from the pointer start-innings or
            // select-bowler set (or, inside a sync batch, from whatever the
            // preceding `bowler` event just set). This is what makes
            // Over.bowlerId the permanent record of who bowled the over.
            bowlerId: inning.currentBowlerId,
        }], { session });
    }

    const delivery1 = resolveDelivery({ runs, extraType, runsFrom });

    // Named against the pre-ball pair; resolveStrike substitutes by player
    // rather than by end, because the rotation below may move them first.
    const dismissedIsStriker = dismissedBatsman === 'striker';
    const dismissedId = wicketType
        ? (dismissedIsStriker ? inning.strikerId : inning.nonStrikerId)
        : null;
    const dismissedName = wicketType
        ? (dismissedIsStriker ? inning.strikerName : inning.nonStrikerName)
        : null;

    const preEventState = {
        totalRuns: inning.totalRuns,
        wickets: inning.wickets,
        legalBalls: inning.legalBalls,
        totalBalls: inning.totalBalls,
        oversCompleted: inning.oversCompleted,
        strikerId: inning.strikerId,
        nonStrikerId: inning.nonStrikerId,
        strikerName: inning.strikerName,
        nonStrikerName: inning.nonStrikerName,
        currentBowlerId: inning.currentBowlerId,
        overTotalRuns: over.totalRuns,
        overLegalDeliveries: over.legalDeliveries,
        extrasSnapshot: serializeExtras(inning.extras),
        overExtrasSnapshot: serializeExtras(over.extras),
    };

    // Over completion, innings completion and "somebody has to bowl the next
    // over" all fall out of one call, off the snapshot above rather than off
    // live state — so the response built after commit and an idempotent
    // replay a week later derive them identically.
    const outcome = resolveBallOutcome({
        isLegal: delivery1.isLegal,
        isWicket: Boolean(wicketType),
        teamRuns: delivery1.teamRuns,
        preEventState,
        totalOvers: match.totalOvers,
        inningsNumber: inning.inningsNumber,
        target: inning.target,
    });

    // Odd runs run rotate strike mid-over — byes, leg-byes and runs off a wide
    // included, since the batsmen crossed for those too; only the automatic
    // penalty never counts. The end of an over always rotates. A single off
    // the last ball of an over does both, and they cancel: same batsman keeps
    // strike.
    const strikeRotated = delivery1.rotatesOnRuns !== outcome.overComplete;

    const [ballEvent] = await BallEvent.create([{
        matchId: match._id,
        inningsId: inning._id,
        overId: over._id,
        overNumber: over.overNumber,
        // On an illegal delivery this is the legal ball it was an attempt at,
        // so consecutive wides repeat it. absoluteBallSeq (below) is the
        // unique per-innings ordering key.
        ballNumber: over.legalDeliveries + 1,
        absoluteBallSeq: inning.totalBalls + 1,
        strikerId: inning.strikerId,
        nonStrikerId: inning.nonStrikerId,
        bowlerId: inning.currentBowlerId,
        strikeRotated,
        isWicket: Boolean(wicketType),
        wicketType,
        dismissedPlayerId: dismissedId,
        dismissedPlayerName: dismissedName,
        incomingBatsmanId: incomingPlayer?._id ?? null,
        incomingBatsmanName: incomingPlayer?.name ?? null,
        runs: delivery1.ballRuns,
        extras: delivery1.ballExtras,
        extraType,
        runsFrom,
        isLegal: delivery1.isLegal,
        idempotencyKey,
        preEventState,
    }], { session });

    over.totalRuns += delivery1.teamRuns;
    applyExtrasBuckets(over.extras, delivery1.buckets);
    if (delivery1.isLegal) {
        over.legalDeliveries += 1;
    }
    if (outcome.overComplete) {
        over.isComplete = true;
    }
    if (wicketType) {
        // Counts wickets in the over including run-outs, which are not the
        // bowler's. The bowler is known now, but crediting him is part of
        // bowler figures, which are still unbuilt.
        over.wickets += 1;
    }
    await over.save({ session });

    inning.totalRuns += delivery1.teamRuns;
    applyExtrasBuckets(inning.extras, delivery1.buckets);
    if (delivery1.isLegal) {
        inning.legalBalls += 1;
    }
    inning.totalBalls += 1;
    if (outcome.overComplete) {
        inning.oversCompleted += 1;
        // Cleared so the next delivery cannot silently inherit this over's
        // bowler. Over.bowlerId above keeps the record; this pointer is what
        // a delivery refuses to run without.
        inning.currentBowlerId = null;
    }
    if (wicketType) {
        inning.wickets += 1;
    }

    // Rotate, then substitute — one call, so an ordinary ball and a wicket
    // ball cannot drift apart.
    Object.assign(inning, resolveStrike({
        strikerId: inning.strikerId,
        strikerName: inning.strikerName,
        nonStrikerId: inning.nonStrikerId,
        nonStrikerName: inning.nonStrikerName,
        rotated: strikeRotated,
        dismissedId,
        incomingId: incomingPlayer?._id ?? null,
        incomingName: incomingPlayer?.name ?? null,
    }));

    // All out, the overs have run out, or — innings 2 only — the target has
    // been chased. Over completion is the only place that can detect
    // overs_complete at all, and target_achieved has to be checked here too,
    // since it can land mid-over.
    let matchJustCompleted = false;
    let inning1ForResult = null;

    if (outcome.inningsComplete) {
        inning.status = 'completed';
        inning.completionReason = outcome.completionReason;

        if (inning.inningsNumber === 1) {
            // The innings transition. start-innings has no way to be told
            // "open innings 2 specifically" — it always resolves against
            // match.currentInnings — so this is the only place that pointer
            // can move. Target itself is set later, by start-innings, once
            // innings 2's Inning document actually exists to carry it.
            match.currentInnings = 2;
            match.status = 'innings_break';
        } else {
            // Innings 2 ending IS match completion — there is no separate
            // detector for it.
            inning1ForResult = await Inning.findOne({
                matchId: match._id,
                inningsNumber: 1,
            }).session(session);

            match.status = 'completed';
            match.completedAt = new Date();
            match.result = resolveMatchResult({
                completionReason: outcome.completionReason,
                battingTeam1: inning1ForResult.battingTeam,
                battingTeam2: inning.battingTeam,
                runs1: inning1ForResult.totalRuns,
                runs2: inning.totalRuns,
                wickets2: inning.wickets,
            });
            matchJustCompleted = true;
        }

        await match.save({ session });
    }

    await inning.save({ session });

    return { ballEvent, over, inning, matchJustCompleted, inning1ForResult };
};

// Shared by scoreBall and syncMatch's ball/bowler branch: both converge on
// applyDelivery for the actual write, and this is everything that follows a
// successfully-applied ball — building the response view, generating a
// completion scorecard, and emitting both socket events. Kept as one
// function specifically so a future change to any of that (a new
// completion side effect, say) has one call site to update rather than two
// that can silently drift apart, which is what scoreBall and syncMatch used
// to be: the same ~45 lines duplicated verbatim between them.
const finishBallDelivery = async ({ match, req, result }) => {
    // The pair comes from the innings rather than the ball: the innings is
    // the authority on who is facing next, and stays so once dismissals can
    // replace a batsman instead of swapping the pair. The over document is
    // handed in so the summary needs no re-read of what we just wrote.
    const view = await buildBallView(
        result.ballEvent,
        result.inning,
        match.totalOvers,
        result.over,
        result.inning.inningsNumber,
        result.inning.target
    );

    if (result.matchJustCompleted) {
        try {
            await Promise.all([
                generateScorecard(match._id, result.inning1ForResult),
                generateScorecard(match._id, result.inning),
            ]);
        } catch (err) {
            // The ball, and the match completion itself, are already safely
            // committed — a scorecard that fails to generate here is not
            // that. GET .../scorecard regenerates on demand, since
            // generateScorecard is an upsert and therefore idempotent.
            console.error('scorecard generation failed', err);
        }
    }

    emitBallEvents(req, result.ballEvent, result.inning, view);

    if (result.matchJustCompleted) {
        const io = req.app.get('io');
        if (io) {
            emitMatchComplete(io, {
                matchId: match._id,
                result: match.result,
                innings: [
                    {
                        inningsNumber: 1,
                        battingTeam: result.inning1ForResult.battingTeam,
                        totalRuns: result.inning1ForResult.totalRuns,
                        wickets: result.inning1ForResult.wickets,
                        overs: formatOvers(result.inning1ForResult.oversCompleted, result.inning1ForResult.legalBalls),
                    },
                    {
                        inningsNumber: 2,
                        battingTeam: result.inning.battingTeam,
                        totalRuns: result.inning.totalRuns,
                        wickets: result.inning.wickets,
                        overs: formatOvers(result.inning.oversCompleted, result.inning.legalBalls),
                    },
                ],
            });
        }
    }

    return view;
};

const scoreBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const input = validateBallInput(req.body);

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (match.status === 'completed' || match.status === 'abandoned') {
        throw new ApiError(400, "MATCH_ALREADY_COMPLETED");
    }

    // Before the bowler check below: after an over ends there IS no current
    // bowler, and replaying the very ball that ended it must still succeed.
    const replayed = await respondWithExistingBall(match, input.idempotencyKey, res, req);
    if (replayed) return replayed;

    // Read once outside the transaction purely to fail fast, before opening a
    // session, on the common rejections. The authoritative checks are inside
    // applyDelivery, against the session-loaded inning below.
    const currentInning = await Inning.findOne({
        matchId: match._id,
        inningsNumber: match.currentInnings,
    });

    if (!currentInning) {
        throw new ApiError(400, "INNINGS_NOT_STARTED");
    }

    if (currentInning.status === 'completed') {
        throw new ApiError(400, "INNINGS_COMPLETED");
    }

    if (!currentInning.currentBowlerId) {
        throw new ApiError(400, "BOWLER_NOT_SELECTED");
    }

    const session = await mongoose.startSession();
    try {
        let result;

        await session.withTransaction(async () => {
            const inning = await Inning.findOne({ matchId: match._id, inningsNumber: match.currentInnings }).session(session);

            // The innings and its openers are created by start-innings. Scoring a
            // ball with nobody assigned would leave the delivery with no striker
            // to credit and no pair to rotate.
            if (!inning) {
                throw new ApiError(400, "INNINGS_NOT_STARTED");
            }

            result = await applyDelivery({ match, inning, session, req, delivery: input });
        });

        const view = await finishBallDelivery({ match, req, result });

        return res.status(200).json(new ApiResponse(200, buildBallResponse(result.ballEvent, result.inning, view), req.t("BALL_SCORED")));
    } catch (err) {
        if (err.code === 11000) {
            const replayedAfterRace = await respondWithExistingBall(match, input.idempotencyKey, res, req);
            if (replayedAfterRace) return replayedAfterRace;
        }
        throw err;
    } finally {
        await session.endSession();
    }
});

// Pure shape check for an undo request — shared by undoBall and by a sync
// batch's per-event validation.
const validateUndoInput = (body) => {
    const { ballEventId } = body;

    if (typeof ballEventId !== 'string' || !ballEventId.trim()) {
        throw new ApiError(400, "BALL_EVENT_ID_REQUIRED");
    }

    const targetId = ballEventId.trim();

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
        throw new ApiError(400, "INVALID_BALL_EVENT_ID");
    }

    return { ballEventId: targetId };
};

// The mirror of applyDelivery. Everything it restores comes from the
// preEventState the ball has carried since it was written — nothing is
// recomputed, and nothing is read from live state, because live state is
// exactly what is wrong.
//
// Deliberately targeted by ballEventId rather than popping whatever is last:
// undo is the button a scorer double-taps on a bad connection, and a blind pop
// would eat a second delivery. Naming the ball makes the retry a no-op instead.
// See the undo section of docs/api.md for why only the latest ball is undoable.
const applyUndo = async ({ match, inning, session, ballEventId }) => {
    const ball = await BallEvent.findOne({
        _id: ballEventId,
        matchId: match._id,
    }).session(session);

    // Gone means a previous attempt already removed it. Answering with
    // alreadyUndone rather than an error is what makes undo idempotent, and it
    // is safe because a ball scored SINCE has a different id — a retried undo
    // matches nothing and correctly does nothing.
    if (!ball) {
        return { inning, alreadyUndone: true };
    }

    const latest = await BallEvent.findOne({ inningsId: inning._id })
        .sort({ absoluteBallSeq: -1 })
        .session(session);

    // Covers both "a later ball exists" and "this ball belongs to an innings
    // that is no longer current" — neither is the latest delivery of the
    // innings being scored.
    if (!latest || !latest._id.equals(ball._id)) {
        throw new ApiError(400, "BALL_NOT_LATEST");
    }

    const over = await Over.findById(ball.overId).session(session);
    const overWasComplete = Boolean(over?.isComplete);
    const inningsWasComplete = inning.status === 'completed';

    await BallEvent.deleteOne({ _id: ball._id }, { session });

    const restored = resolveUndo({
        preEventState: ball.preEventState,
        isWicket: ball.isWicket,
        overWickets: over?.wickets ?? 0,
    });

    let overRemoved = false;

    if (over) {
        // An over with no deliveries left has to GO, not sit at zero — see
        // undoBall's original comment on why a zeroed-out Over would credit
        // the wrong bowler and corrupt the consecutive-over check.
        const remaining = await BallEvent.findOne({ overId: over._id })
            .select('_id')
            .session(session);

        if (remaining) {
            Object.assign(over, restored.over);
            await over.save({ session });
        } else {
            await Over.deleteOne({ _id: over._id }, { session });
            overRemoved = true;
        }
    }

    Object.assign(inning, restored.inning);
    await inning.save({ session });

    return {
        inning,
        ball,
        alreadyUndone: false,
        // A single-delivery over can never have been complete, so this and
        // overRemoved are mutually exclusive in practice; the guard is here
        // so the flag never claims an over that no longer exists.
        overReopened: overWasComplete && !overRemoved,
        overRemoved,
        inningsReopened: inningsWasComplete,
    };
};

// Builds the same complete-state snapshot both undo-ball and sync return after
// a write — never a diff. See undoBall's own comment on why: the console
// re-renders from these fields and must never compute a reversal or a replay
// itself.
const buildStateSnapshot = async (inning) => {
    const [bowler, remainingBall] = await Promise.all([
        buildBowlerState(inning),
        BallEvent.findOne({ inningsId: inning._id }).select('_id'),
    ]);

    return {
        strike: await buildStrike(inning, inning._id),
        bowler,
        target: inning.target ?? null,
        inningsTotals: {
            totalRuns: inning.totalRuns,
            wickets: inning.wickets,
            legalBalls: inning.legalBalls,
            totalBalls: inning.totalBalls,
            oversCompleted: inning.oversCompleted,
            extras: serializeExtras(inning.extras),
        },
        overs: formatOvers(inning.oversCompleted, inning.legalBalls),
        inningsComplete: inning.status === 'completed',
        canUndo: Boolean(remainingBall),
    };
};

const undoBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { ballEventId } = validateUndoInput(req.body);

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (match.status === 'completed' || match.status === 'abandoned') {
        throw new ApiError(400, "MATCH_ALREADY_COMPLETED");
    }

    const session = await mongoose.startSession();
    try {
        let result;

        await session.withTransaction(async () => {
            const inning = await Inning.findOne({
                matchId: match._id,
                inningsNumber: match.currentInnings,
            }).session(session);

            // No innings means nothing was ever scored, so there is nothing this
            // ball id could refer to either.
            if (!inning) {
                throw new ApiError(400, "INNINGS_NOT_STARTED");
            }

            result = await applyUndo({ match, inning, session, ballEventId });
        });

        const { inning } = result;
        const state = await buildStateSnapshot(inning);

        if (result.alreadyUndone) {
            // Nothing changed, so the room is told nothing. The caller still
            // gets the current state, which is the point of answering 200.
            return res.status(200).json(new ApiResponse(200, {
                matchId: match._id,
                inningsId: inning._id,
                inningsNumber: inning.inningsNumber,
                ...state,
                alreadyUndone: true,
                undone: null,
                overReopened: false,
                overRemoved: false,
                inningsReopened: false,
            }, req.t("BALL_UNDONE")));
        }

        const { ball } = result;

        const undone = {
            ballEventId: ball._id,
            overNumber: ball.overNumber,
            ballNumber: ball.ballNumber,
            absoluteBallSeq: ball.absoluteBallSeq,
            runs: ball.runs,
            extras: ball.extras,
            extraType: ball.extraType,
            runsFrom: ball.runsFrom,
            isLegal: ball.isLegal,
            wicket: buildWicket(ball),
        };

        const io = req.app.get('io');
        if (io) {
            emitScoreUndo(io, {
                matchId: match._id,
                inningsId: inning._id,
                inningsNumber: inning.inningsNumber,
                totalRuns: inning.totalRuns,
                wickets: inning.wickets,
                overs: state.overs,
                target: state.target,
                extras: state.inningsTotals.extras,
                strike: state.strike,
                bowler: state.bowler,
                // Named differently from score:update's `lastBall` on purpose:
                // this identifies a delivery to REMOVE, not one to append.
                undoneBall: {
                    ballEventId: ball._id,
                    overNumber: ball.overNumber,
                    ballNumber: ball.ballNumber,
                    absoluteBallSeq: ball.absoluteBallSeq,
                },
                overReopened: result.overReopened,
                inningsReopened: result.inningsReopened,
            });
        }

        return res.status(200).json(new ApiResponse(200, {
            matchId: match._id,
            inningsId: inning._id,
            inningsNumber: inning.inningsNumber,
            ...state,
            alreadyUndone: false,
            undone,
            overReopened: result.overReopened,
            overRemoved: result.overRemoved,
            inningsReopened: result.inningsReopened,
        }, req.t("BALL_UNDONE")));
    } finally {
        await session.endSession();
    }
});

const SYNC_EVENT_TYPES = ['ball', 'bowler', 'undo'];
// Well inside express.json's 100kb body limit; see docs/api.md.
const SYNC_BATCH_MAX_EVENTS = 120;

// Whole-batch structural checks — everything a client could get wrong before
// any event's own content is even looked at. These reject the request outright,
// unlike a per-event failure below, which stops the batch where it is and keeps
// whatever already applied. See "The conflict check" in docs/api.md.
const validateSyncRequest = (body) => {
    const { inningsNumber, baseAbsoluteBallSeq, events } = body;

    if (!Number.isInteger(baseAbsoluteBallSeq) || baseAbsoluteBallSeq < 0) {
        throw new ApiError(400, "SYNC_BASE_SEQ_REQUIRED");
    }

    if (!Array.isArray(events) || events.length === 0) {
        throw new ApiError(400, "SYNC_EVENTS_REQUIRED");
    }

    if (events.length > SYNC_BATCH_MAX_EVENTS) {
        throw new ApiError(400, "SYNC_BATCH_TOO_LARGE");
    }

    let sawUndo = false;
    let sawOther = false;

    for (const event of events) {
        if (!SYNC_EVENT_TYPES.includes(event?.type)) {
            throw new ApiError(400, "SYNC_INVALID_EVENT_TYPE");
        }
        if (event.type === 'undo') sawUndo = true;
        else sawOther = true;
    }

    if (sawUndo && sawOther) {
        throw new ApiError(400, "SYNC_MIXED_BATCH");
    }

    // A malformed inningsNumber can never equal match.currentInnings either
    // (checked once the match is loaded, below), so it surfaces as the same
    // code as a genuine mismatch rather than inventing a second one for it.
    if (inningsNumber !== 1 && inningsNumber !== 2) {
        throw new ApiError(400, "SYNC_INNINGS_MISMATCH");
    }

    return { inningsNumber, baseAbsoluteBallSeq, events, isUndoBatch: sawUndo };
};

// Applies an ordered batch of events a client scored while it had no signal.
// See docs/api.md's sync section for the full contract this implements; the
// short version is: a lost response is not a conflict (a retry's own writes
// are recognised and skipped), an individually-bad event stops the batch where
// it is rather than rejecting the whole thing, and a genuine conflict — the
// server holding deliveries this client never queued, or an undo landing on a
// ball someone else has already scored past — refuses the batch whole and
// leaves Match.syncStatus at "conflict" for the client to surface.
const syncMatch = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { inningsNumber, baseAbsoluteBallSeq, events, isUndoBatch } = validateSyncRequest(req.body);

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (match.status === 'completed' || match.status === 'abandoned') {
        throw new ApiError(400, "MATCH_ALREADY_COMPLETED");
    }

    if (inningsNumber !== match.currentInnings) {
        throw new ApiError(400, "SYNC_INNINGS_MISMATCH");
    }

    // Fail fast, before opening a session, on the common case of a batch
    // arriving before start-innings has ever been called for this innings.
    const precheckInning = await Inning.findOne({ matchId: match._id, inningsNumber });
    if (!precheckInning) {
        throw new ApiError(400, "INNINGS_NOT_STARTED");
    }

    const session = await mongoose.startSession();
    try {
        let finalInning = null;
        let appliedCount = 0;
        let skippedCount = 0;
        let failedAt = null;
        let failedCode = null;
        let lastBallResult = null;
        let lastUndoResult = null;

        await session.withTransaction(async () => {
            // Reset on every attempt: withTransaction retries this callback on
            // a transient error, and a retry must start from a clean count
            // against a freshly re-read inning, not accumulate across attempts.
            finalInning = null;
            appliedCount = 0;
            skippedCount = 0;
            failedAt = null;
            failedCode = null;
            lastBallResult = null;
            lastUndoResult = null;

            const inning = await Inning.findOne({ matchId: match._id, inningsNumber }).session(session);
            if (!inning) {
                throw new ApiError(400, "INNINGS_NOT_STARTED");
            }

            if (isUndoBatch) {
                for (let i = 0; i < events.length; i += 1) {
                    const event = events[i];
                    try {
                        const { ballEventId } = validateUndoInput(event);
                        const result = await applyUndo({ match, inning, session, ballEventId });

                        if (result.alreadyUndone) {
                            skippedCount += 1;
                        } else {
                            appliedCount += 1;
                            lastUndoResult = result;
                        }
                    } catch (err) {
                        if (!(err instanceof ApiError)) throw err;

                        // Someone scored past the ball this client meant to
                        // remove — a conflict, not a transient/per-event
                        // failure to skip past. See docs/api.md.
                        if (err.message === 'BALL_NOT_LATEST') {
                            throw new ApiError(409, "SYNC_CONFLICT");
                        }

                        failedAt = i;
                        failedCode = err.message;
                        break;
                    }
                }
            } else {
                const serverSeq = inning.totalBalls;
                let ballsToSkip = 0;

                if (serverSeq !== baseAbsoluteBallSeq) {
                    const ahead = serverSeq - baseAbsoluteBallSeq;
                    const batchBallKeys = events
                        .filter((event) => event.type === 'ball')
                        .map((event) => event.idempotencyKey);

                    const serverKeysAhead = ahead > 0
                        ? (await BallEvent.find({
                            inningsId: inning._id,
                            absoluteBallSeq: { $gt: baseAbsoluteBallSeq },
                        })
                            .sort({ absoluteBallSeq: 1 })
                            .limit(ahead)
                            .select('idempotencyKey')
                            .session(session)
                        ).map((b) => b.idempotencyKey)
                        : [];

                    const decision = resolveSyncDecision({
                        baseSeq: baseAbsoluteBallSeq,
                        serverSeq,
                        batchBallKeys,
                        serverKeysAhead,
                    });

                    if (decision.decision === 'conflict') {
                        throw new ApiError(409, "SYNC_CONFLICT");
                    }

                    ballsToSkip = decision.resumeAfterBallCount;
                }

                for (let i = 0; i < events.length; i += 1) {
                    const event = events[i];

                    // Still inside the server-confirmed prefix from an earlier,
                    // interrupted sync attempt. A `bowler` event in this span is
                    // a no-op if re-applied (the pointer it would set is already
                    // set), so it is simply skipped rather than risk anything.
                    if (ballsToSkip > 0 && (event.type === 'ball' || event.type === 'bowler')) {
                        if (event.type === 'ball') ballsToSkip -= 1;
                        skippedCount += 1;
                        continue;
                    }

                    try {
                        if (event.type === 'ball') {
                            const result = await applyDelivery({
                                match,
                                inning,
                                session,
                                req,
                                delivery: validateBallInput(event),
                            });
                            lastBallResult = result;
                        } else {
                            const { bowlerName } = validateBowlerInput(event);
                            await applyBowlerSelection({ match, inning, session, req, bowlerName });
                        }

                        appliedCount += 1;
                    } catch (err) {
                        if (!(err instanceof ApiError)) throw err;

                        failedAt = i;
                        failedCode = err.message;
                        break;
                    }
                }
            }

            match.syncStatus = failedAt === null ? 'synced' : 'syncing';
            await match.save({ session });

            finalInning = inning;
        });

        const state = await buildStateSnapshot(finalInning);

        if (!isUndoBatch && lastBallResult) {
            await finishBallDelivery({ match, req, result: lastBallResult });
        } else if (isUndoBatch && lastUndoResult) {
            const io = req.app.get('io');
            if (io) {
                const { ball } = lastUndoResult;
                emitScoreUndo(io, {
                    matchId: match._id,
                    inningsId: finalInning._id,
                    inningsNumber: finalInning.inningsNumber,
                    totalRuns: finalInning.totalRuns,
                    wickets: finalInning.wickets,
                    overs: state.overs,
                    target: state.target,
                    extras: state.inningsTotals.extras,
                    strike: state.strike,
                    bowler: state.bowler,
                    undoneBall: {
                        ballEventId: ball._id,
                        overNumber: ball.overNumber,
                        ballNumber: ball.ballNumber,
                        absoluteBallSeq: ball.absoluteBallSeq,
                    },
                    overReopened: lastUndoResult.overReopened,
                    inningsReopened: lastUndoResult.inningsReopened,
                });
            }
        }

        return res.status(200).json(new ApiResponse(200, {
            matchId: match._id,
            inningsId: finalInning._id,
            inningsNumber: finalInning.inningsNumber,
            syncStatus: match.syncStatus,
            baseAbsoluteBallSeq,
            absoluteBallSeq: finalInning.totalBalls,
            appliedCount,
            skippedCount,
            failedAt,
            failedCode,
            // The id of the last successfully-applied ball in this batch —
            // null on an undo batch, or on one that applied zero ball events
            // (bowler-only, or fully skipped as someone else's retry). Undo
            // only ever targets the single most recent ball, so this is
            // exactly what a client needs to undo a delivery that was
            // originally scored via a batch rather than score-ball directly,
            // where it would otherwise have no id to target at all.
            lastBallEventId: lastBallResult?.ballEvent._id ?? null,
            state,
        }, req.t("SYNC_APPLIED")));
    } catch (err) {
        if (err instanceof ApiError && err.message === 'SYNC_CONFLICT') {
            await Match.updateOne({ _id: match._id }, { syncStatus: 'conflict' });
        }
        throw err;
    } finally {
        await session.endSession();
    }
});

// The entire surface an unauthenticated viewer can reach, and the only match
// route with no verifyJwt. That is deliberate, and the /public/ segment in the
// path is there so it is visible in the URL rather than only in the router.
//
// Read-only in the strongest available sense: it takes no body, writes nothing,
// and there is no sibling public route that does. Every scoring endpoint carries
// verifyJwt AND an independent createdBy ownership check — see the route table
// in docs/api.md, and tests/routes.auth.test.js, which fails the build if a
// route ever loses its middleware.
// Both innings' finalized figures plus the match result. Gated on
// match.status === 'completed' rather than on the Scorecard documents
// existing — by the time a client can even reach this route with a completed
// match, generateScorecard has already run at completion time (see the
// try/catch around it in scoreBall). The regeneration below covers the one
// case that guarantee doesn't: that call failing after the match itself had
// already committed. generateScorecard is an upsert, so calling it again here
// is always safe, never a duplicate.
const getMatchScorecard = catchAsync(async (req, res) => {
    const { matchId } = req.params;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    // Abandoned is included alongside completed: abandonMatch generates a
    // scorecard for whatever innings exist at the moment it's called, and
    // this is the only endpoint that serves one back. An abandoned match
    // never reaches 'completed', so excluding it here would make that
    // scorecard permanently unreachable.
    if (match.status !== 'completed' && match.status !== 'abandoned') {
        throw new ApiError(400, "SCORECARD_NOT_READY");
    }

    let [scorecard1, scorecard2] = await Promise.all([
        Scorecard.findOne({ matchId: match._id, inningsNumber: 1 }),
        Scorecard.findOne({ matchId: match._id, inningsNumber: 2 }),
    ]);

    if (!scorecard1 || !scorecard2) {
        const [inning1, inning2] = await Promise.all([
            Inning.findOne({ matchId: match._id, inningsNumber: 1 }),
            Inning.findOne({ matchId: match._id, inningsNumber: 2 }),
        ]);

        // A completed match always has both innings — but an abandoned one
        // can have only innings 1, if play never reached innings 2. Guard
        // against generateScorecard(matchId, null), which reads `inning._id`
        // unconditionally and would throw.
        [scorecard1, scorecard2] = await Promise.all([
            scorecard1 ?? (inning1 ? generateScorecard(match._id, inning1) : null),
            scorecard2 ?? (inning2 ? generateScorecard(match._id, inning2) : null),
        ]);
    }

    // Scorecard.battingTeam is a side label ('teamA'/'teamB'), the same
    // convention as everywhere else in this API — so this is the one place a
    // result screen can resolve what they actually mean, the same lookup
    // getPublicMatch already does for the same reason. Without it, a result
    // screen reached by direct navigation (no live session to have cached a
    // name from) would have no team name to show at all.
    const [teamA, teamB] = await Promise.all([
        Team.findById(match.teamA),
        Team.findById(match.teamB),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        teamA: { name: teamA?.name ?? null },
        teamB: { name: teamB?.name ?? null },
        result: match.result ?? null,
        innings: [scorecard1, scorecard2],
    }, req.t("SCORECARD_FETCHED")));
});

const getPublicMatch = catchAsync(async (req, res) => {
    const { code } = req.params;

    if (!code?.trim()) {
        throw new ApiError(400, "MATCH_CODE_REQUIRED");
    }

    const match = await findMatchByIdOrCode(code);

    // An unknown code and a soft-deleted match answer identically, on purpose.
    // Telling them apart would make this endpoint an oracle: an enumerator could
    // learn which codes have ever existed, which is most of the work of guessing
    // one. `findMatchByIdOrCode` already collapses both to null.
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    const [teamA, teamB, inning] = await Promise.all([
        Team.findById(match.teamA),
        Team.findById(match.teamB),
        Inning.findOne({ matchId: match._id, inningsNumber: match.currentInnings }),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        // An explicit pick, not a spread of the Mongoose document. `createdBy`
        // is the one field on Match that identifies a person with an account and
        // it must never leave the server here; `syncStatus`, `isDeleted` and the
        // timestamps are internal bookkeeping a spectator has no use for.
        // Spreading would leak all of it the moment anyone adds a field.
        match: {
            matchId: match._id,
            joinCode: match.joinCode ?? null,
            title: match.title ?? null,
            teamA: { name: teamA?.name ?? null },
            teamB: { name: teamB?.name ?? null },
            totalOvers: match.totalOvers,
            tossWinner: match.tossWinner ?? null,
            tossDecision: match.tossDecision ?? null,
            status: match.status,
            matchType: match.matchType,
            venue: match.venue ?? null,
            currentInnings: match.currentInnings,
            result: match.result ?? null,
        },
        // Exactly the object `match:state` emits, so a spectator paints from
        // here once and then applies socket events to the same shape. Null
        // before start-innings: an early viewer gets the fixture and an empty
        // scoreboard, which is the truth, rather than an error.
        innings: await buildInningsState(match._id, inning),
    }, req.t("MATCH_FETCHED")));
});

// A live/innings-break match that will never finish — rain, a no-show, a
// setup abandoned mid-way. Distinct from deleteMatch below: this keeps the
// match in history with whatever partial scorecard exists, the same way a
// completed match does, rather than removing it.
const abandonMatch = catchAsync(async (req, res) => {
    const { matchId } = req.params;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (match.status === 'completed' || match.status === 'abandoned') {
        throw new ApiError(400, "MATCH_ALREADY_COMPLETED");
    }

    match.status = 'abandoned';
    match.completedAt = new Date();
    await match.save();

    // Best-effort, same as the matchJustCompleted branch in scoreBall above:
    // the abandonment itself is already committed, and generateScorecard is
    // an upsert, so a failure here just means GET .../scorecard regenerates
    // it on demand later rather than losing anything.
    try {
        const innings = await Inning.find({ matchId: match._id });
        await Promise.all(innings.map((inning) => generateScorecard(match._id, inning)));
    } catch (err) {
        console.error('scorecard generation failed on abandon', err);
    }

    const io = req.app.get('io');
    if (io) {
        emitMatchAbandoned(io, { matchId: match._id, status: match.status });
    }

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        status: match.status,
    }, req.t("MATCH_ABANDONED")));
});

// Soft-delete only — never a hard delete, same convention as every other
// isDeleted-bearing resource (see the backend CLAUDE.md's Database
// Conventions). Works regardless of Match.status: a mis-created match
// (wrong team names typed) needs to disappear from history whether or not
// anyone ever scored a ball on it.
const deleteMatch = catchAsync(async (req, res) => {
    const { matchId } = req.params;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    match.isDeleted = true;
    await match.save();

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
    }, req.t("MATCH_DELETED")));
});

// The first list endpoint in this codebase — see the backend CLAUDE.md's own
// pagination rule for why `?page`/`?limit` with an enforced max rather than
// an unbounded `.find()`: Match is exactly the kind of collection this rule
// exists for. Feeds the client's match-history/home screen.
const getMatchHistory = catchAsync(async (req, res) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || DEFAULT_HISTORY_LIMIT;

    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw new ApiError(400, "INVALID_PAGINATION", { params: { max: MAX_HISTORY_LIMIT } });
    }

    const filter = { createdBy: req.user._id, isDeleted: false };

    const [matches, total] = await Promise.all([
        Match.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Match.countDocuments(filter),
    ]);

    // Batched rather than one Team.findById per match — a history page is
    // exactly the N+1 shape a per-match lookup would create.
    const teamIds = [...new Set(matches.flatMap((match) => [String(match.teamA), String(match.teamB)]))];
    const teams = await Team.find({ _id: { $in: teamIds } });
    const teamNameById = new Map(teams.map((team) => [String(team._id), team.name]));

    return res.status(200).json(new ApiResponse(200, {
        matches: matches.map((match) => ({
            matchId: match._id,
            // Unlike getPublicMatch/getMatchScorecard, this response carries
            // team ids, not just names — a card here can route straight back
            // into the scoring console for a still-live match, which needs
            // teamA/teamB ids the same shape `create` originally returned
            // them in, not just display names.
            teamA: { id: match.teamA, name: teamNameById.get(String(match.teamA)) ?? null },
            teamB: { id: match.teamB, name: teamNameById.get(String(match.teamB)) ?? null },
            totalOvers: match.totalOvers,
            status: match.status,
            result: match.result ?? null,
            createdAt: match.createdAt,
        })),
        page,
        limit,
        total,
    }, req.t("MATCH_HISTORY_FETCHED")));
});

export { createMatch, startInnings, selectBowler, scoreBall, undoBall, syncMatch, getMatchScorecard, getPublicMatch, abandonMatch, deleteMatch, getMatchHistory };
