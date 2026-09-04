import { PlayerMatchStats } from '../models/playerMatchStats.model.js';
import { CareerStats } from '../models/careerStats.model.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Inverse of formatOvers: "4.2" -> 26 legal deliveries. Needed because
 * Scorecard.bowlingScores[].overs stores the display string, not the raw
 * ball count a career total needs to sum. Pure, no model.
 */
export const parseOvers = (overs) => {
    const [wholeOvers, ballsRemainder] = overs.split('.').map(Number);
    return wholeOvers * 6 + ballsRemainder;
};

/**
 * `runs / timesOut`, NOT `runs / inningsBatted` — a not-out innings adds to
 * both `runs` and `inningsBatted` but never to `timesOut`. `null` (not `0`)
 * when the player has never been dismissed: `0` would read as "averages
 * nothing", when the true state is "no average yet". See docs/api.md.
 */
export const battingAverage = (runs, timesOut) =>
    (timesOut > 0 ? round2(runs / timesOut) : null);

/**
 * Recomputed from cumulative runs/balls, never averaged from per-match
 * strike rates — averaging rates is the same class of error as averaging
 * economy across overs of different lengths.
 */
export const strikeRate = (runs, ballsFaced) =>
    (ballsFaced > 0 ? round2((runs / ballsFaced) * 100) : 0);

/** Same not-an-average-of-rates rule as strikeRate, for bowling. */
export const economy = (runsConceded, legalDeliveries) =>
    (legalDeliveries > 0 ? round2(runsConceded / (legalDeliveries / 6)) : 0);

/**
 * One player's combined contribution from both of a match's just-generated
 * Scorecard documents — at most one batting line (from whichever innings
 * they batted in) and one bowling line (from the other), since a player
 * bats in at most one innings and bowls in at most the other of a
 * two-innings match. Returns a Map keyed by playerId (string) to
 * `{ battingLine, bowlingLine }`, matching PlayerMatchStats' own shape.
 *
 * Pure — takes plain Scorecard-shaped objects, touches no model. `scorecards`
 * is the two innings' Scorecard documents (either may be null/absent for an
 * abandoned match that never reached innings 2 — callers deciding whether to
 * call this at all for an abandoned match is a separate decision, see
 * docs/api.md's "Open items").
 */
export const buildMatchContributions = (scorecards) => {
    const contributions = new Map();

    const touch = (playerId) => {
        const key = String(playerId);
        if (!contributions.has(key)) {
            contributions.set(key, { battingLine: null, bowlingLine: null });
        }
        return contributions.get(key);
    };

    for (const scorecard of scorecards) {
        if (!scorecard) continue;

        for (const line of scorecard.battingScores ?? []) {
            const entry = touch(line.playerId);
            entry.battingLine = {
                runs: line.runs,
                balls: line.balls,
                fours: line.fours,
                sixes: line.sixes,
                isNotOut: line.isNotOut,
                wasFifty: line.runs >= 50 && line.runs < 100,
                wasHundred: line.runs >= 100,
            };
        }

        for (const line of scorecard.bowlingScores ?? []) {
            const entry = touch(line.playerId);
            entry.bowlingLine = {
                legalDeliveries: parseOvers(line.overs),
                runs: line.runs,
                wickets: line.wickets,
                maidens: line.maidens,
                wides: line.wides,
                noBalls: line.noBalls,
            };
        }
    }

    return contributions;
};

// Every summed CareerStats field, and the PlayerMatchStats line + subfield it
// reads from. `matchesPlayed` isn't here: it increments on the row's own
// presence transition (null -> non-null), computed separately in
// applyCareerStatsIncrement, not from either line's own fields.
const BATTING_SUM_FIELDS = [
    ['runs', 'runs'],
    ['ballsFaced', 'balls'],
    ['fours', 'fours'],
    ['sixes', 'sixes'],
    ['fifties', 'wasFifty'],
    ['hundreds', 'wasHundred'],
];

const BOWLING_SUM_FIELDS = [
    ['legalDeliveries', 'legalDeliveries'],
    ['runsConceded', 'runs'],
    ['wickets', 'wickets'],
    ['maidens', 'maidens'],
];

const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0));

/**
 * The `$inc` object to move CareerStats from `before` (a PlayerMatchStats
 * document, or null for a first-time contribution) to `after` (the
 * `{battingLine, bowlingLine}` about to be written). First-time and
 * corrected both go through this same path: `before`'s fields default to 0
 * via `num`, so a first-time delta is just `after`'s own values.
 *
 * Pure — no model, no I/O.
 */
export const computeDelta = (before, after) => {
    const delta = {};

    const beforeBatting = before?.battingLine ?? null;
    const beforeBowling = before?.bowlingLine ?? null;

    delta.inningsBatted = (after.battingLine ? 1 : 0) - (beforeBatting ? 1 : 0);
    delta.inningsBowled = (after.bowlingLine ? 1 : 0) - (beforeBowling ? 1 : 0);
    delta.timesOut = (after.battingLine && !after.battingLine.isNotOut ? 1 : 0)
        - (beforeBatting && !beforeBatting.isNotOut ? 1 : 0);
    delta.notOuts = (after.battingLine?.isNotOut ? 1 : 0) - (beforeBatting?.isNotOut ? 1 : 0);

    for (const [careerField, lineField] of BATTING_SUM_FIELDS) {
        delta[careerField] = num(after.battingLine?.[lineField]) - num(beforeBatting?.[lineField]);
    }

    for (const [careerField, lineField] of BOWLING_SUM_FIELDS) {
        delta[careerField] = num(after.bowlingLine?.[lineField]) - num(beforeBowling?.[lineField]);
    }

    return delta;
};

const isBetterHighScore = (candidate, current) =>
    !current || candidate.runs > current.runs;

const isBetterBowling = (candidate, current) =>
    !current || candidate.wickets > current.wickets
        || (candidate.wickets === current.wickets && candidate.runs < current.runs);

/**
 * Recomputes highScore from every PlayerMatchStats row this player has —
 * the only correct way to move a max-of-all-time field DOWN, which a delta
 * cannot do. Only called on a correction (see applyCareerStatsIncrement),
 * never on a first-time contribution, so the extra query is rare by design.
 */
const rescanHighScore = async (playerId) => {
    const best = await PlayerMatchStats.findOne({ playerId, battingLine: { $ne: null } })
        .sort({ 'battingLine.runs': -1 })
        .lean();

    const highScore = best
        ? { runs: best.battingLine.runs, isNotOut: best.battingLine.isNotOut, matchId: best.matchId }
        : null;

    await CareerStats.updateOne({ playerId }, { $set: { highScore } });
};

/** Bowling's equivalent of rescanHighScore — see its own comment. */
const rescanBestBowling = async (playerId) => {
    const best = await PlayerMatchStats.findOne({ playerId, bowlingLine: { $ne: null } })
        .sort({ 'bowlingLine.wickets': -1, 'bowlingLine.runs': 1 })
        .lean();

    const bestBowling = best
        ? { wickets: best.bowlingLine.wickets, runs: best.bowlingLine.runs, matchId: best.matchId }
        : null;

    await CareerStats.updateOne({ playerId }, { $set: { bestBowling } });
};

/**
 * Applies one match's already-generated Scorecards to every involved
 * player's PlayerMatchStats + CareerStats. Called alongside
 * generateScorecard in finishBallDelivery's matchJustCompleted branch, with
 * the same best-effort posture: the match itself is already committed, and a
 * failure here must not undo that.
 *
 * `matchId` need not be re-derived from `scorecards` — both are always the
 * two just-generated Scorecard documents for one match, so it's the caller's
 * to pass directly.
 */
export const applyCareerStatsIncrement = async (matchId, scorecards) => {
    const contributions = buildMatchContributions(scorecards);

    for (const [playerId, after] of contributions) {
        // `before: 'before'` — the document as it stood BEFORE this write,
        // or null the first time. That's what tells computeDelta (and the
        // correction-vs-first-time branch below) whether this is a fresh
        // contribution or a replace.
        const before = await PlayerMatchStats.findOneAndUpdate(
            { playerId, matchId },
            {
                $set: {
                    playerId,
                    matchId,
                    battingLine: after.battingLine,
                    bowlingLine: after.bowlingLine,
                    generatedAt: new Date(),
                },
            },
            { upsert: true, returnDocument: 'before' }
        );

        const delta = computeDelta(before, after);
        delta.matchesPlayed = before ? 0 : 1;

        await CareerStats.findOneAndUpdate(
            { playerId },
            { $setOnInsert: { playerId }, $inc: delta },
            { upsert: true }
        );

        const isCorrection = before !== null;

        if (isCorrection) {
            // Correctness over cost: a correction is the narrow undo-the-
            // completing-ball path, not the common case, so an unconditional
            // rescan is the simple, always-right answer rather than trying
            // to infer whether THIS match was the record's source.
            await rescanHighScore(playerId);
            await rescanBestBowling(playerId);
        } else if (after.battingLine || after.bowlingLine) {
            const current = await CareerStats.findOne({ playerId }, 'highScore bestBowling').lean();

            if (after.battingLine && isBetterHighScore(after.battingLine, current?.highScore)) {
                await CareerStats.updateOne(
                    { playerId },
                    {
                        $set: {
                            highScore: {
                                runs: after.battingLine.runs,
                                isNotOut: after.battingLine.isNotOut,
                                matchId,
                            },
                        },
                    }
                );
            }

            if (after.bowlingLine && isBetterBowling(after.bowlingLine, current?.bestBowling)) {
                await CareerStats.updateOne(
                    { playerId },
                    {
                        $set: {
                            bestBowling: {
                                wickets: after.bowlingLine.wickets,
                                runs: after.bowlingLine.runs,
                                matchId,
                            },
                        },
                    }
                );
            }
        }
    }
};
