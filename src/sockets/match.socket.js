import { Match } from '../models/match.model.js';
import { Inning } from '../models/inning.model.js';
import { formatOvers } from '../utils/formatOvers.js';

export const registerMatchSocket = (io) => {
    io.on('connection', (socket) => {
        socket.on('match:join', async ({ matchId } = {}) => {
            try {
                if (!matchId) return;

                socket.join(`match:${matchId}`);

                const match = await Match.findById(matchId);
                if (!match) return;

                const inning = await Inning.findOne({ matchId, inningsNumber: match.currentInnings });

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
                    }
                    : {
                        matchId,
                        inningsNumber: match.currentInnings,
                        totalRuns: 0,
                        wickets: 0,
                        overs: '0.0',
                        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
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
