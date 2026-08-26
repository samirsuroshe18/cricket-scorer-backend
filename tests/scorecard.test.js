import { buildBattingScores, buildBowlingScores } from '../src/utils/scorecard.js';

const names = new Map([
    ['striker1', 'Rohit'],
    ['nonStriker1', 'Kohli'],
    ['bowler1', 'Bumrah'],
    ['bowler2', 'Shami'],
]);

// Only the fields the builders read; the real BallEvent carries more.
const ball = (overrides = {}) => ({
    strikerId: 'striker1',
    nonStrikerId: 'nonStriker1',
    bowlerId: 'bowler1',
    runs: 0,
    isLegal: true,
    isWicket: false,
    wicketType: null,
    dismissedPlayerId: null,
    ...overrides,
});

describe('buildBattingScores', () => {
    it('credits runs and balls faced to the striker only', () => {
        const scores = buildBattingScores([ball({ runs: 4 }), ball({ runs: 1 })], names);
        const rohit = scores.find((s) => s.playerId === 'striker1');
        expect(rohit).toMatchObject({ runs: 5, balls: 2, fours: 1, sixes: 0 });
    });

    it('does not count a wide or no-ball as a ball faced', () => {
        const scores = buildBattingScores([ball({ runs: 0, isLegal: false })], names);
        expect(scores.find((s) => s.playerId === 'striker1').balls).toBe(0);
    });

    it('counts fours and sixes off the bat only', () => {
        const scores = buildBattingScores(
            [ball({ runs: 4 }), ball({ runs: 6 }), ball({ runs: 4 })],
            names
        );
        const rohit = scores.find((s) => s.playerId === 'striker1');
        expect(rohit).toMatchObject({ fours: 2, sixes: 1 });
    });

    it('seats the non-striker even if he never faces a ball this innings', () => {
        const scores = buildBattingScores([ball({ runs: 1 })], names);
        const kohli = scores.find((s) => s.playerId === 'nonStriker1');
        expect(kohli).toMatchObject({ runs: 0, balls: 0, isNotOut: true });
    });

    it('marks a dismissed batsman out, with the dismissal type', () => {
        const scores = buildBattingScores(
            [ball({ isWicket: true, wicketType: 'bowled', dismissedPlayerId: 'striker1' })],
            names
        );
        const rohit = scores.find((s) => s.playerId === 'striker1');
        expect(rohit).toMatchObject({ isNotOut: false, dismissalType: 'bowled' });
    });

    it('leaves a never-dismissed batsman not out', () => {
        const scores = buildBattingScores([ball({ runs: 1 })], names);
        expect(scores.find((s) => s.playerId === 'striker1').isNotOut).toBe(true);
    });

    it('computes strike rate from runs and legal balls faced', () => {
        const scores = buildBattingScores(
            [ball({ runs: 4 }), ball({ runs: 2 }), ball({ runs: 0, isLegal: false })],
            names
        );
        const rohit = scores.find((s) => s.playerId === 'striker1');
        expect(rohit.balls).toBe(2);
        expect(rohit.strikeRate).toBe(300);
    });

    it('reports zero strike rate for a batsman who faced no legal ball', () => {
        const scores = buildBattingScores([ball({ runs: 1 })], names);
        expect(scores.find((s) => s.playerId === 'nonStriker1').strikeRate).toBe(0);
    });

    it('orders batsmen by first appearance, not by dismissal order', () => {
        const scores = buildBattingScores(
            [
                ball({ strikerId: 'nonStriker1', nonStrikerId: 'striker1' }),
                ball({ isWicket: true, wicketType: 'bowled', dismissedPlayerId: 'nonStriker1' }),
            ],
            names
        );
        expect(scores.map((s) => s.playerId)).toEqual(['nonStriker1', 'striker1']);
    });
});

// Only the fields buildBowlingScores reads; the real Over carries more.
const over = (overrides = {}) => ({
    bowlerId: 'bowler1',
    totalRuns: 0,
    legalDeliveries: 6,
    isComplete: true,
    extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
    ...overrides,
});

describe('buildBowlingScores', () => {
    it('excludes byes and leg-byes from runs conceded', () => {
        const scores = buildBowlingScores(
            [over({ totalRuns: 10, extras: { wides: 0, noBalls: 0, byes: 4, legByes: 2 } })],
            [],
            names
        );
        expect(scores[0]).toMatchObject({ runs: 4, wides: 0, noBalls: 0 });
    });

    it('charges wide and no-ball runs to the bowler', () => {
        const scores = buildBowlingScores(
            [over({ totalRuns: 6, extras: { wides: 3, noBalls: 1, byes: 0, legByes: 0 } })],
            [],
            names
        );
        // wides + noBalls are part of totalRuns and NOT subtracted, unlike byes/legByes.
        expect(scores[0].runs).toBe(6);
        expect(scores[0]).toMatchObject({ wides: 3, noBalls: 1 });
    });

    it('sums legal deliveries across overs into an overs-and-balls figure', () => {
        const scores = buildBowlingScores(
            [over({ legalDeliveries: 6 }), over({ legalDeliveries: 4, isComplete: false })],
            [],
            names
        );
        expect(scores[0].overs).toBe('1.4');
    });

    it('credits a maiden only for a complete over with zero chargeable runs', () => {
        const scores = buildBowlingScores(
            [
                over({ totalRuns: 0, isComplete: true }),
                over({ totalRuns: 0, isComplete: false }),
                over({ totalRuns: 4, extras: { wides: 0, noBalls: 0, byes: 4, legByes: 0 }, isComplete: true }),
            ],
            [],
            names
        );
        // Second over: incomplete, does not count. Third: complete but the 4
        // runs are all byes (not chargeable) — still a maiden by that measure.
        expect(scores[0].maidens).toBe(2);
    });

    it('credits a wicket to the bowler for a bowled dismissal', () => {
        const scores = buildBowlingScores(
            [over({})],
            [ball({ isWicket: true, wicketType: 'bowled', bowlerId: 'bowler1' })],
            names
        );
        expect(scores[0].wickets).toBe(1);
    });

    it('does not credit the bowler for a run out', () => {
        const scores = buildBowlingScores(
            [over({})],
            [ball({ isWicket: true, wicketType: 'run_out', bowlerId: 'bowler1' })],
            names
        );
        expect(scores[0].wickets).toBe(0);
    });

    it('keeps two bowlers separate, in the order they first bowled', () => {
        const scores = buildBowlingScores(
            [over({ bowlerId: 'bowler2', totalRuns: 8 }), over({ bowlerId: 'bowler1', totalRuns: 3 })],
            [],
            names
        );
        expect(scores.map((s) => s.playerId)).toEqual(['bowler2', 'bowler1']);
        expect(scores[0].runs).toBe(8);
        expect(scores[1].runs).toBe(3);
    });

    it('reports zero economy for a bowler who has not bowled a legal ball', () => {
        const scores = buildBowlingScores(
            [over({ legalDeliveries: 0, isComplete: false })],
            [],
            names
        );
        expect(scores[0].economy).toBe(0);
    });

    it('computes economy as runs per over', () => {
        const scores = buildBowlingScores([over({ totalRuns: 12, legalDeliveries: 6 })], [], names);
        expect(scores[0].economy).toBe(12);
    });
});
