import { Match } from '../models/match.model.js';
import { Inning } from '../models/inning.model.js';
import { Over } from '../models/over.model.js';
import { Player } from '../models/player.model.js';
import { formatOvers } from '../utils/formatOvers.js';

// Who is bowling, and who bowled the over before — the pair that tells a scorer
// resuming on a fresh app launch whether a bowler is still owed:
// currentBowlerId null alongside a non-null previousBowlerId IS the "between
// overs, nobody selected yet" state. previousBowlerId is read off Over.bowlerId
// rather than a second pointer on Inning, so there is nothing to keep in sync.
//
// Names are looked up rather than denormalized: unlike the batsmen, a bowler's
// name is only needed on join and at over end, never per delivery.
const buildBowlerState = async (inning) => {
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

export const registerMatchSocket = (io) => {
    io.on('connection', (socket) => {
        socket.on('match:join', async ({ matchId } = {}) => {
            try {
                if (!matchId) return;

                socket.join(`match:${matchId}`);

                const match = await Match.findById(matchId);
                if (!match) return;

                const inning = await Inning.findOne({ matchId, inningsNumber: match.currentInnings });

                const bowler = await buildBowlerState(inning);

                const state = inning
                    ? {
                        matchId,
                        inningsNumber: inning.inningsNumber,
                        totalRuns: inning.totalRuns,
                        wickets: inning.wickets,
                        overs: formatOvers(inning.oversCompleted, inning.legalBalls),
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
                        },
                        bowler,
                    }
                    : {
                        matchId,
                        inningsNumber: match.currentInnings,
                        totalRuns: 0,
                        wickets: 0,
                        overs: '0.0',
                        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
                        // No innings yet means no openers and no bowler chosen yet.
                        strike: null,
                        bowler: null,
                    };

                socket.emit('match:state', state);
            } catch (err) {
                console.error('match:join failed', err);
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
