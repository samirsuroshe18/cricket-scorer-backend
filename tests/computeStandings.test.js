import { computeStandings } from '../src/utils/computeStandings.js';

describe('computeStandings — zero rows and sort', () => {
    it('gives every enrolled team a zero row when no matches have been played, sorted by name', () => {
        const teams = [{ id: 't2', name: 'Bravo' }, { id: 't1', name: 'Alpha' }];
        const result = computeStandings({ teams, matches: [] });
        expect(result).toEqual([
            { teamId: 't1', teamName: 'Alpha', played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0, nrr: 0 },
            { teamId: 't2', teamName: 'Bravo', played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0, nrr: 0 },
        ]);
    });
});

describe('computeStandings — win/loss points', () => {
    it('awards 2 points and a win to teamA, 0 points and a loss to teamB', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamA',
            totalOvers: 20, innings: [],
        }];
        const result = computeStandings({ teams, matches });
        expect(result[0]).toEqual({ teamId: 't1', teamName: 'Alpha', played: 1, won: 1, lost: 0, tied: 0, noResult: 0, points: 2, nrr: 0 });
        expect(result[1]).toEqual({ teamId: 't2', teamName: 'Bravo', played: 1, won: 0, lost: 1, tied: 0, noResult: 0, points: 0, nrr: 0 });
    });

    it('sorts the team with more points first, regardless of team name', () => {
        const teams = [{ id: 't1', name: 'Zulu' }, { id: 't2', name: 'Alpha' }];
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamA',
            totalOvers: 20, innings: [],
        }];
        const result = computeStandings({ teams, matches });
        expect(result.map((r) => r.teamId)).toEqual(['t1', 't2']);
    });
});
