import { Inning } from '../models/inning.model.js';
import { Over } from '../models/over.model.js';
import { Player } from '../models/player.model.js';
import { formatOvers } from '../utils/formatOvers.js';
import { findMatchByIdOrCode } from '../utils/matchLookup.js';
import { currentPartnership, liveStrikeFigures } from '../utils/scorecard.js';
import { isRateLimited } from '../utils/socketRateLimit.js';

// Who is bowling, and who bowled the over before — the pair that tells a scorer
// resuming on a fresh app launch whether a bowler is still owed:
// currentBowlerId null alongside a non-null previousBowlerId IS the "between
// overs, nobody selected yet" state. previousBowlerId is read off Over.bowlerId
// rather than a second pointer on Inning, so there is nothing to keep in sync.
//
// Names are looked up rather than denormalized: unlike the batsmen, a bowler's
// name is only needed on join and at over end, never per delivery.
export const buildBowlerState = async (inning) => {
    if (!inning) return null;

    const previousOver = inning.oversCompleted > 0
        ? await Over.findOne({ inningsId: inning._id, overNumber: inning.oversCompleted })
        : null;

    const previousBowlerId = previousOver?.bowlerId ?? null;

    const [current, previous] = await Promise.all([
        inning.currentBowlerId ? Player.findById(inning.currentBowlerId) : null,
        previousBowlerId ? Player.findById(previousBowlerId) : null,
    ]);

    return {
        currentBowlerId: inning.currentBowlerId ?? null,
        currentBowlerName: current?.name ?? null,
        previousBowlerId,
        previousBowlerName: previous?.name ?? null,
    };
};

/**
 * The live half of a match: the score, who is at the crease, who is bowling.
 *
 * Shared by the `match:state` join ack and by the public REST endpoint, so a
 * spectator painting from REST and then applying socket events is applying them
 * to exactly the shape it already has. Two builders for one thing would mean two
 * chances to disagree about the score.
 *
 * Null when the innings has not started; each caller decides what to show for
 * that, because they genuinely differ — REST reports `innings: null` so a
 * spectator sees a fixture, while the socket sends a zeroed board.
 */
export const buildInningsState = async (matchId, inning) => {
    if (!inning) return null;

    const [strikeFigures, partnership] = await Promise.all([
        liveStrikeFigures(inning._id, inning.strikerId, inning.nonStrikerId),
        currentPartnership(inning._id),
    ]);

    return {
        matchId,
        inningsNumber: inning.inningsNumber,
        totalRuns: inning.totalRuns,
        wickets: inning.wickets,
        overs: formatOvers(inning.oversCompleted, inning.legalBalls),
        // Null on innings 1 — nothing to chase yet. Lets a join/resume or a
        // spectator's initial fetch know the target without having been
        // present for start-innings, where it is otherwise only ever sent.
        target: inning.target ?? null,
        extras: {
            wides: inning.extras?.wides ?? 0,
            noBalls: inning.extras?.noBalls ?? 0,
            byes: inning.extras?.byes ?? 0,
            legByes: inning.extras?.legByes ?? 0,
        },
        strike: {
            strikerId: inning.strikerId ?? null,
            strikerName: inning.strikerName ?? null,
            nonStrikerId: inning.nonStrikerId ?? null,
            nonStrikerName: inning.nonStrikerName ?? null,
            ...strikeFigures,
        },
        // Only ever sent here — a join ack or a spectator's initial fetch —
        // never on `score:update`. A client already tracks this incrementally
        // ball to ball; what it cannot do on its own is seed it correctly the
        // moment it connects mid-partnership, which is exactly what this
        // is for. See `currentPartnership`'s own doc comment.
        ...partnership,
        bowler: await buildBowlerState(inning),
    };
};

export const registerMatchSocket = (io) => {
    io.on('connection', (socket) => {
        // One of exactly two inbound socket events in the application — this
        // one, and match:leave below — and both only touch room membership,
        // never stored state.
        //
        // That is load-bearing, not incidental: there is no io.use() middleware
        // and no per-event authentication, so any handler added here that
        // reads or writes match state would be world-writable the moment it
        // is written. Scoring actions travel over REST, where verifyJwt and
        // the createdBy ownership check both apply. See "What a spectator
        // connection cannot do" in docs/api.md before adding a third handler
        // here.
        socket.on('match:join', async ({ matchId, code } = {}) => {
            try {
                // The join-code space (six characters, ~30-character alphabet)
                // is otherwise brute-forceable with zero friction: no auth on
                // this event, and a miss returns nothing at all (deliberate —
                // see findMatchByIdOrCode's own comment). Keyed on the
                // connecting IP rather than this one socket, so opening a
                // fresh connection doesn't reset the count. Checked before any
                // DB work, so a request over budget costs nothing further.
                if (isRateLimited(socket.handshake.address)) return;

                // `code` accepts either form — the 24-hex id or the six-character
                // share code — so a spectator holding only the code never needs
                // to resolve it first. `matchId` stays supported unchanged: the
                // scorer's console has always sent it.
                const match = await findMatchByIdOrCode(code ?? matchId);
                if (!match) return;

                // Always named by matchId, even when joined by code, so every
                // emit call site stays untouched and a scorer and a spectator
                // provably land in the same room.
                socket.join(`match:${match._id}`);

                const inning = await Inning.findOne({
                    matchId: match._id,
                    inningsNumber: match.currentInnings,
                });

                const state = (await buildInningsState(match._id, inning)) ?? {
                    matchId: match._id,
                    inningsNumber: match.currentInnings,
                    totalRuns: 0,
                    wickets: 0,
                    overs: '0.0',
                    target: null,
                    extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
                    // No innings yet means no openers and no bowler chosen
                    // yet, and no partnership yet either — zeroed rather
                    // than omitted, so this shape always matches the
                    // populated path's (buildInningsState's own), which
                    // always carries both keys once an innings exists.
                    strike: null,
                    partnershipRuns: 0,
                    partnershipBalls: 0,
                    bowler: null,
                };

                socket.emit('match:state', state);
            } catch (err) {
                console.error('match:join failed', err);
            }
        });

        // The read-only inverse of match:join's `socket.join` above — removes
        // this connection from a room it no longer cares about (navigating
        // from one match's spectate/console screen to another, in one
        // continuous app session) so a stale connection doesn't keep sitting
        // in every room it has ever joined for the rest of the process.
        // Deliberately does no DB lookup and no ownership check, unlike
        // match:join: it never reads or writes anything, its only effect is
        // on the calling socket's own room membership, and leaving a room
        // this socket was never in — or a room name it invented outright —
        // is a no-op, never something that could affect any other
        // connection's data. See docs/api.md's "What a spectator connection
        // cannot do" before adding a THIRD handler here; this one keeps that
        // section's guarantee intact rather than breaking it, precisely
        // because it stays in this narrower, structurally-harmless category.
        socket.on('match:leave', ({ matchId } = {}) => {
            if (typeof matchId === 'string' && matchId) {
                socket.leave(`match:${matchId}`);
            }
        });
    });
};

export const emitScoreUpdate = (io, payload) => {
    io.to(`match:${payload.matchId}`).emit('score:update', payload);
};

// Always emitted AFTER this ball's score:update, so a spectator applies the
// delivery before being handed the end-of-over card for it.
export const emitOverComplete = (io, payload) => {
    io.to(`match:${payload.matchId}`).emit('over:complete', payload);
};

// A separate event rather than a score:update with the totals rolled back: a
// spectator keeping a ball-by-ball strip has to REMOVE a delivery here, and
// reusing score:update would have `lastBall` mean the opposite of what it means
// everywhere else. The totals block is the same shape, so a view that only
// tracks the score can still handle both through one path.
export const emitScoreUndo = (io, payload) => {
    io.to(`match:${payload.matchId}`).emit('score:undo', payload);
};

// Same room as everything else — a spectator who joined mid-match needs no
// separate subscription to learn the match ended. Always the last event on
// the ball that ends it: score:update, then over:complete if that ball also
// closed an over, then this — so a client applies the delivery and the over
// card before being told there is nothing further to apply.
export const emitMatchComplete = (io, payload) => {
    io.to(`match:${payload.matchId}`).emit('match:complete', payload);
};

// Same room, same "no separate subscription needed" reasoning as
// emitMatchComplete — a spectator watching a match that gets called off
// (rain, a no-show) needs to be told the same way, not left staring at a
// score that silently stopped updating.
export const emitMatchAbandoned = (io, payload) => {
    io.to(`match:${payload.matchId}`).emit('match:abandoned', payload);
};
