import { BallEvent } from '../models/ballEvent.model.js';
import { Over } from '../models/over.model.js';
import { Player } from '../models/player.model.js';
import { Scorecard } from '../models/scorecard.model.js';
import { formatOvers } from './formatOvers.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * One batting line per player who faced a ball or was dismissed, derived from
 * the innings' full delivery history. There is no running per-batsman counter
 * anywhere in the scoring hot path — batting figures are "still out of scope"
 * for score-ball itself, by design — so this aggregates after the fact rather
 * than reading a live total.
 *
 * `ballEvents` must be every delivery for one innings, sorted oldest first —
 * that order is also the returned batting order, since a player's first
 * appearance (as striker or non-striker) is what seats them, not their first
 * dismissal. `playerNames` is an id→name Map; BallEvent only denormalizes
 * dismissed/incoming names, not the striker's, so a caller with DB access
 * resolves the rest before calling this.
 *
 * Pure — takes plain arrays/Maps, touches no model. Covered by
 * tests/scorecard.test.js.
 */
export const buildBattingScores = (ballEvents, playerNames) => {
    const lines = new Map();
    const order = [];

    const touch = (id) => {
        if (!id) return null;
        const key = String(id);
        if (!lines.has(key)) {
            lines.set(key, {
                playerId: id,
                playerName: playerNames.get(key) ?? 'Unknown',
                runs: 0,
                balls: 0,
                fours: 0,
                sixes: 0,
                dismissalType: null,
                isNotOut: true,
            });
            order.push(key);
        }
        return lines.get(key);
    };

    for (const ball of ballEvents) {
        const striker = touch(ball.strikerId);
        touch(ball.nonStrikerId);

        striker.runs += ball.runs;
        if (ball.isLegal) striker.balls += 1;
        if (ball.runs === 4) striker.fours += 1;
        if (ball.runs === 6) striker.sixes += 1;

        if (ball.isWicket && ball.dismissedPlayerId) {
            const dismissed = touch(ball.dismissedPlayerId);
            dismissed.dismissalType = ball.wicketType;
            dismissed.isNotOut = false;
        }
    }

    return order.map((key) => {
        const line = lines.get(key);
        return {
            ...line,
            strikeRate: line.balls > 0 ? round2((line.runs / line.balls) * 100) : 0,
        };
    });
};

/**
 * One bowling line per bowler, built from two sources rather than reading
 * BallEvent's `extras` alone: `Over` already carries the wides/noBalls/byes/
 * legByes split per over per bowler (the same breakdown score-ball maintains
 * for the live console), so runs conceded and the extras columns come from
 * there. Only wicket credit needs BallEvent — a run out is not the bowler's,
 * so it is excluded by wicketType, not by inference.
 *
 * `overs` must be every Over document for one innings, sorted by overNumber —
 * that order is also bowling order (first over bowled seats a bowler first).
 *
 * Pure — takes plain arrays/Maps, touches no model. Covered by
 * tests/scorecard.test.js.
 */
export const buildBowlingScores = (overs, ballEvents, playerNames) => {
    const lines = new Map();
    const order = [];

    const touch = (id) => {
        if (!id) return null;
        const key = String(id);
        if (!lines.has(key)) {
            lines.set(key, {
                playerId: id,
                playerName: playerNames.get(key) ?? 'Unknown',
                legalDeliveries: 0,
                maidens: 0,
                runs: 0,
                wickets: 0,
                wides: 0,
                noBalls: 0,
            });
            order.push(key);
        }
        return lines.get(key);
    };

    for (const over of overs) {
        if (!over.bowlerId) continue;
        const line = touch(over.bowlerId);
        const chargeableRuns = over.totalRuns - (over.extras?.byes ?? 0) - (over.extras?.legByes ?? 0);

        line.legalDeliveries += over.legalDeliveries;
        line.runs += chargeableRuns;
        line.wides += over.extras?.wides ?? 0;
        line.noBalls += over.extras?.noBalls ?? 0;
        if (over.isComplete && chargeableRuns === 0) line.maidens += 1;
    }

    for (const ball of ballEvents) {
        if (ball.isWicket && ball.wicketType && ball.wicketType !== 'run_out' && ball.bowlerId) {
            touch(ball.bowlerId).wickets += 1;
        }
    }

    return order.map((key) => {
        const line = lines.get(key);
        const oversBowled = Math.floor(line.legalDeliveries / 6);
        return {
            playerId: line.playerId,
            playerName: line.playerName,
            overs: formatOvers(oversBowled, line.legalDeliveries),
            maidens: line.maidens,
            runs: line.runs,
            wickets: line.wickets,
            economy: line.legalDeliveries > 0 ? round2(line.runs / (line.legalDeliveries / 6)) : 0,
            wides: line.wides,
            noBalls: line.noBalls,
        };
    });
};

/**
 * Fetches one innings' full history, resolves the player names BallEvent
 * doesn't carry, and upserts its Scorecard — safe to call more than once for
 * the same innings, since `{matchId, inningsNumber}` is unique and this always
 * replaces rather than accumulates. That idempotency is what lets
 * GET .../scorecard regenerate on demand if match-completion's own call
 * failed or was never reached.
 */
export const generateScorecard = async (matchId, inning) => {
    const [ballEvents, overs] = await Promise.all([
        BallEvent.find({ inningsId: inning._id }).sort({ absoluteBallSeq: 1 }),
        Over.find({ inningsId: inning._id }).sort({ overNumber: 1 }),
    ]);

    const playerIds = new Set();
    for (const ball of ballEvents) {
        if (ball.strikerId) playerIds.add(String(ball.strikerId));
        if (ball.nonStrikerId) playerIds.add(String(ball.nonStrikerId));
        if (ball.dismissedPlayerId) playerIds.add(String(ball.dismissedPlayerId));
        if (ball.bowlerId) playerIds.add(String(ball.bowlerId));
    }

    const players = await Player.find({ _id: { $in: [...playerIds] } });
    const playerNames = new Map(players.map((p) => [String(p._id), p.name]));

    const battingScores = buildBattingScores(ballEvents, playerNames);
    const bowlingScores = buildBowlingScores(overs, ballEvents, playerNames);

    const extrasTotal = inning.extras.wides + inning.extras.noBalls + inning.extras.byes + inning.extras.legByes;

    return Scorecard.findOneAndUpdate(
        { matchId, inningsNumber: inning.inningsNumber },
        {
            matchId,
            inningsId: inning._id,
            inningsNumber: inning.inningsNumber,
            battingTeam: inning.battingTeam,
            battingScores,
            bowlingScores,
            totalRuns: inning.totalRuns,
            totalWickets: inning.wickets,
            totalOvers: formatOvers(inning.oversCompleted, inning.legalBalls),
            extras: {
                total: extrasTotal,
                wides: inning.extras.wides,
                noBalls: inning.extras.noBalls,
                byes: inning.extras.byes,
                legByes: inning.extras.legByes,
            },
            generatedAt: new Date(),
        },
        { upsert: true, new: true }
    );
};
