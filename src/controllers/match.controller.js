import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { Team } from '../models/team.model.js';
import { Inning } from '../models/inning.model.js';
import { Over } from '../models/over.model.js';
import { BallEvent } from '../models/ballEvent.model.js';
import { formatOvers } from '../utils/formatOvers.js';
import { emitScoreUpdate } from '../sockets/match.socket.js';
import { resolveDelivery, EXTRA_TYPES, RUNS_FROM } from '../utils/resolveDelivery.js';

const MIN_OVERS = 1;
const MAX_OVERS = 50;
const MAX_RUNS_PER_BALL = 6;

const findOrCreateTeam = async (name, createdBy) => {
    try {
        return await Team.findOneAndUpdate(
            { createdBy, name },
            { $setOnInsert: { name, createdBy } },
            { upsert: true, returnDocument: 'after' }
        );
    } catch (err) {
        // Two concurrent create-match calls for the same new team name can both
        // miss the "existing" check and race the upsert — the unique
        // {createdBy, name} index rejects the loser with E11000. The winner
        // already created the doc, so just fetch it instead of failing the request.
        if (err.code === 11000) {
            return Team.findOne({ createdBy, name });
        }
        throw err;
    }
};

const createMatch = catchAsync(async (req, res) => {
    const { teamAName, teamBName, totalOvers } = req.body;

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

    const [teamA, teamB] = await Promise.all([
        findOrCreateTeam(trimmedA, req.user._id),
        findOrCreateTeam(trimmedB, req.user._id),
    ]);

    const match = await Match.create({
        teamA: teamA._id,
        teamB: teamB._id,
        totalOvers,
        createdBy: req.user._id,
    });

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        teamA: { id: teamA._id, name: teamA.name },
        teamB: { id: teamB._id, name: teamB.name },
        totalOvers: match.totalOvers,
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

const applyExtrasBuckets = (target, buckets) => {
    target.wides += buckets.wides;
    target.noBalls += buckets.noBalls;
    target.byes += buckets.byes;
    target.legByes += buckets.legByes;
};

const buildBallResponse = (ballEvent, inning) => ({
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
    inningsTotals: {
        totalRuns: inning.totalRuns,
        wickets: inning.wickets,
        legalBalls: inning.legalBalls,
        totalBalls: inning.totalBalls,
        oversCompleted: inning.oversCompleted,
        extras: serializeExtras(inning.extras),
    },
});

const buildLiveScorePayload = (ballEvent, inning) => ({
    matchId: ballEvent.matchId,
    inningsId: ballEvent.inningsId,
    inningsNumber: inning.inningsNumber,
    totalRuns: inning.totalRuns,
    wickets: inning.wickets,
    overs: formatOvers(inning.oversCompleted, inning.legalBalls),
    extras: serializeExtras(inning.extras),
    lastBall: {
        runs: ballEvent.runs,
        extras: ballEvent.extras,
        extraType: ballEvent.extraType,
        runsFrom: ballEvent.runsFrom,
        isLegal: ballEvent.isLegal,
        overNumber: ballEvent.overNumber,
        ballNumber: ballEvent.ballNumber,
        absoluteBallSeq: ballEvent.absoluteBallSeq,
    },
});

const respondWithExistingBall = async (matchId, idempotencyKey, res, req) => {
    const existing = await BallEvent.findOne({ matchId, idempotencyKey });
    if (!existing) return null;
    const inning = await Inning.findById(existing.inningsId);

    const io = req.app.get('io');
    if (io) emitScoreUpdate(io, buildLiveScorePayload(existing, inning));

    return res.status(200).json(new ApiResponse(200, buildBallResponse(existing, inning), req.t("BALL_SCORED")));
};

const scoreBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { runs, idempotencyKey } = req.body;

    if (!Number.isInteger(runs) || runs < 0 || runs > MAX_RUNS_PER_BALL) {
        throw new ApiError(400, "RUNS_OUT_OF_RANGE");
    }

    if (!idempotencyKey?.trim()) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED");
    }

    // `extraType` is the delivery fault (wide/no_ball); `runsFrom` is who the runs
    // belong to (bat/bye/leg_bye). Independent — a no-ball can also go for byes.
    const extraType = req.body.extraType ?? null;
    const runsFrom = req.body.runsFrom ?? 'bat';

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

    const replayed = await respondWithExistingBall(match._id, idempotencyKey, res, req);
    if (replayed) return replayed;

    const session = await mongoose.startSession();
    try {
        let result;

        await session.withTransaction(async () => {
            let inning = await Inning.findOne({ matchId: match._id, inningsNumber: match.currentInnings }).session(session);

            if (!inning) {
                const battingTeam = match.battingFirst || 'teamA';
                const bowlingTeam = battingTeam === 'teamA' ? 'teamB' : 'teamA';

                [inning] = await Inning.create([{
                    matchId: match._id,
                    inningsNumber: match.currentInnings,
                    battingTeam,
                    bowlingTeam,
                }], { session });

                if (match.status === 'upcoming') {
                    match.status = 'live';
                    await match.save({ session });
                }
            }

            const overNumber = inning.oversCompleted + 1;
            let over = await Over.findOne({ inningsId: inning._id, overNumber }).session(session);
            if (!over) {
                [over] = await Over.create([{
                    matchId: match._id,
                    inningsId: inning._id,
                    overNumber,
                }], { session });
            }

            const delivery = resolveDelivery({ runs, extraType, runsFrom });

            const preEventState = {
                totalRuns: inning.totalRuns,
                wickets: inning.wickets,
                legalBalls: inning.legalBalls,
                totalBalls: inning.totalBalls,
                oversCompleted: inning.oversCompleted,
                currentBatterId: inning.currentBatterId,
                nonStrikerId: inning.nonStrikerId,
                currentBowlerId: inning.currentBowlerId,
                overTotalRuns: over.totalRuns,
                overLegalDeliveries: over.legalDeliveries,
                extrasSnapshot: serializeExtras(inning.extras),
                overExtrasSnapshot: serializeExtras(over.extras),
            };

            const [ballEvent] = await BallEvent.create([{
                matchId: match._id,
                inningsId: inning._id,
                overId: over._id,
                overNumber: over.overNumber,
                // On an illegal delivery this is the legal ball it was an attempt
                // at, so consecutive wides repeat it. absoluteBallSeq (below) is
                // the unique per-innings ordering key.
                ballNumber: over.legalDeliveries + 1,
                absoluteBallSeq: inning.totalBalls + 1,
                runs: delivery.ballRuns,
                extras: delivery.ballExtras,
                extraType,
                runsFrom,
                isLegal: delivery.isLegal,
                idempotencyKey,
                preEventState,
            }], { session });

            over.totalRuns += delivery.teamRuns;
            applyExtrasBuckets(over.extras, delivery.buckets);
            if (delivery.isLegal) {
                over.legalDeliveries += 1;
            }
            // Only the *transition* to 6 completes the over — guards against
            // double-counting oversCompleted if an already-complete over is seen.
            const overJustCompleted = delivery.isLegal && over.legalDeliveries === 6;
            if (overJustCompleted) {
                over.isComplete = true;
            }
            await over.save({ session });

            inning.totalRuns += delivery.teamRuns;
            applyExtrasBuckets(inning.extras, delivery.buckets);
            if (delivery.isLegal) {
                inning.legalBalls += 1;
            }
            inning.totalBalls += 1;
            if (overJustCompleted) {
                inning.oversCompleted += 1;
            }
            await inning.save({ session });

            result = { ballEvent, inning };
        });

        const io = req.app.get('io');
        if (io) emitScoreUpdate(io, buildLiveScorePayload(result.ballEvent, result.inning));

        return res.status(200).json(new ApiResponse(200, buildBallResponse(result.ballEvent, result.inning), req.t("BALL_SCORED")));
    } catch (err) {
        if (err.code === 11000) {
            const replayedAfterRace = await respondWithExistingBall(match._id, idempotencyKey, res, req);
            if (replayedAfterRace) return replayedAfterRace;
        }
        throw err;
    } finally {
        await session.endSession();
    }
});

export { createMatch, scoreBall };
