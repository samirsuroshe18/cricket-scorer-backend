import { computeTeamStats } from '../src/utils/teamStats.js';

const TEAM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const asTeamA = (winner) => ({ teamA: TEAM, teamB: OTHER, result: { winner } });
const asTeamB = (winner) => ({ teamA: OTHER, teamB: TEAM, result: { winner } });

describe('computeTeamStats', () => {
    it('returns all zeros and empty form for no matches', () => {
        expect(computeTeamStats(TEAM, [])).toEqual({
            played: 0, won: 0, lost: 0, tied: 0, noResult: 0, winPercentage: 0, form: [],
        });
    });

    it('counts a win when the team is teamA and winner is teamA', () => {
        const stats = computeTeamStats(TEAM, [asTeamA('teamA')]);
        expect(stats).toMatchObject({ played: 1, won: 1, lost: 0, winPercentage: 100, form: ['W'] });
    });

    it('counts a win when the team is teamB and winner is teamB', () => {
        const stats = computeTeamStats(TEAM, [asTeamB('teamB')]);
        expect(stats).toMatchObject({ played: 1, won: 1, lost: 0, form: ['W'] });
    });

    it('counts a loss when the winner is the other side', () => {
        const stats = computeTeamStats(TEAM, [asTeamA('teamB'), asTeamB('teamA')]);
        expect(stats).toMatchObject({ played: 2, won: 0, lost: 2, winPercentage: 0, form: ['L', 'L'] });
    });

    it('counts tie and no_result separately', () => {
        const stats = computeTeamStats(TEAM, [asTeamA('tie'), asTeamB('no_result')]);
        expect(stats).toMatchObject({ played: 2, won: 0, lost: 0, tied: 1, noResult: 1, form: ['T', 'N'] });
    });

    it('skips matches with no recorded winner', () => {
        const stats = computeTeamStats(TEAM, [{ teamA: TEAM, teamB: OTHER }, asTeamA('teamA')]);
        expect(stats.played).toBe(1);
    });

    it('rounds winPercentage to one decimal', () => {
        const matches = [
            ...Array.from({ length: 7 }, () => asTeamA('teamA')),
            ...Array.from({ length: 5 }, () => asTeamA('teamB')),
        ];
        expect(computeTeamStats(TEAM, matches).winPercentage).toBe(58.3);
    });

    it('form is newest first and capped at 5', () => {
        // Input is newest first: W L W W T L N
        const matches = [
            asTeamA('teamA'), asTeamA('teamB'), asTeamA('teamA'), asTeamA('teamA'),
            asTeamA('tie'), asTeamA('teamB'), asTeamA('no_result'),
        ];
        const stats = computeTeamStats(TEAM, matches);
        expect(stats.form).toEqual(['W', 'L', 'W', 'W', 'T']);
        expect(stats.played).toBe(7);
    });
});
