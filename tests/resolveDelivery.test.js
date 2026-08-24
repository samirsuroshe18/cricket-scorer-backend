import { resolveDelivery } from '../src/utils/resolveDelivery.js';

const sum = (buckets) => buckets.wides + buckets.noBalls + buckets.byes + buckets.legByes;

// One row per scenario in the "Scoring rules" table of docs/api.md.
const SCENARIOS = [
    {
        name: 'dot ball',
        input: { runs: 0 },
        teamRuns: 0, ballRuns: 0, ballExtras: 0, isLegal: true,
        rotatesOnRuns: false,
        buckets: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
    },
    {
        name: 'four off the bat',
        input: { runs: 4 },
        teamRuns: 4, ballRuns: 4, ballExtras: 0, isLegal: true,
        rotatesOnRuns: false,
        buckets: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
    },
    {
        name: '2 byes',
        input: { runs: 2, runsFrom: 'bye' },
        teamRuns: 2, ballRuns: 0, ballExtras: 2, isLegal: true,
        rotatesOnRuns: false,
        buckets: { wides: 0, noBalls: 0, byes: 2, legByes: 0 },
    },
    {
        name: '1 leg-bye',
        input: { runs: 1, runsFrom: 'leg_bye' },
        teamRuns: 1, ballRuns: 0, ballExtras: 1, isLegal: true,
        rotatesOnRuns: true,
        buckets: { wides: 0, noBalls: 0, byes: 0, legByes: 1 },
    },
    {
        name: 'plain wide',
        input: { runs: 0, extraType: 'wide' },
        teamRuns: 1, ballRuns: 0, ballExtras: 1, isLegal: false,
        rotatesOnRuns: false,
        buckets: { wides: 1, noBalls: 0, byes: 0, legByes: 0 },
    },
    {
        name: 'wide with 2 run',
        input: { runs: 2, extraType: 'wide' },
        teamRuns: 3, ballRuns: 0, ballExtras: 3, isLegal: false,
        rotatesOnRuns: false,
        buckets: { wides: 3, noBalls: 0, byes: 0, legByes: 0 },
    },
    {
        name: 'plain no-ball',
        input: { runs: 0, extraType: 'no_ball' },
        teamRuns: 1, ballRuns: 0, ballExtras: 1, isLegal: false,
        rotatesOnRuns: false,
        buckets: { wides: 0, noBalls: 1, byes: 0, legByes: 0 },
    },
    {
        name: 'no-ball, six off the bat',
        input: { runs: 6, extraType: 'no_ball' },
        teamRuns: 7, ballRuns: 6, ballExtras: 1, isLegal: false,
        rotatesOnRuns: false,
        buckets: { wides: 0, noBalls: 1, byes: 0, legByes: 0 },
    },
    {
        name: 'no-ball plus 2 byes',
        input: { runs: 2, extraType: 'no_ball', runsFrom: 'bye' },
        teamRuns: 3, ballRuns: 0, ballExtras: 3, isLegal: false,
        rotatesOnRuns: false,
        buckets: { wides: 0, noBalls: 1, byes: 2, legByes: 0 },
    },
];

describe('resolveDelivery', () => {
    it.each(SCENARIOS)('$name', ({ input, ...expected }) => {
        expect(resolveDelivery(input)).toEqual({
            ballRuns: expected.ballRuns,
            ballExtras: expected.ballExtras,
            isLegal: expected.isLegal,
            rotatesOnRuns: expected.rotatesOnRuns,
            buckets: expected.buckets,
            teamRuns: expected.teamRuns,
        });
    });

    // The two properties the whole contract rests on — checked across every
    // legal combination, not just the documented rows.
    const ALL_COMBINATIONS = [null, 'wide', 'no_ball'].flatMap((extraType) =>
        ['bat', 'bye', 'leg_bye']
            // a wide never carries a runsFrom — the controller rejects it
            .filter((runsFrom) => !(extraType === 'wide' && runsFrom !== 'bat'))
            .flatMap((runsFrom) =>
                [0, 1, 2, 3, 4, 5, 6].map((runs) => ({ runs, extraType, runsFrom }))
            )
    );

    it.each(ALL_COMBINATIONS)(
        'teamRuns === ballRuns + ballExtras for %o',
        (input) => {
            const { teamRuns, ballRuns, ballExtras } = resolveDelivery(input);
            expect(teamRuns).toBe(ballRuns + ballExtras);
        }
    );

    it.each(ALL_COMBINATIONS)(
        'extras buckets sum to ballExtras for %o',
        (input) => {
            const { ballExtras, buckets } = resolveDelivery(input);
            expect(sum(buckets)).toBe(ballExtras);
        }
    );

    it.each(ALL_COMBINATIONS)(
        'rotatesOnRuns tracks the parity of runs run for %o',
        (input) => {
            expect(resolveDelivery(input).rotatesOnRuns).toBe(input.runs % 2 === 1);
        }
    );

    // The rule the strike contract rests on: rotation follows the runs the
    // batsmen actually ran, whoever they are credited to.
    it('rotates on odd runs regardless of who they are credited to', () => {
        expect(resolveDelivery({ runs: 1 }).rotatesOnRuns).toBe(true);
        expect(resolveDelivery({ runs: 3, runsFrom: 'bye' }).rotatesOnRuns).toBe(true);
        expect(resolveDelivery({ runs: 1, runsFrom: 'leg_bye' }).rotatesOnRuns).toBe(true);
        expect(resolveDelivery({ runs: 1, extraType: 'wide' }).rotatesOnRuns).toBe(true);
        expect(resolveDelivery({ runs: 1, extraType: 'no_ball' }).rotatesOnRuns).toBe(true);
    });

    // The penalty run is awarded, never run between the wickets — so a wide or
    // no-ball that nobody ran off does not change the strike, even though it
    // adds a run to the team total.
    it('never rotates on the automatic penalty alone', () => {
        const wide = resolveDelivery({ runs: 0, extraType: 'wide' });
        expect(wide.teamRuns).toBe(1);
        expect(wide.rotatesOnRuns).toBe(false);

        const noBall = resolveDelivery({ runs: 0, extraType: 'no_ball' });
        expect(noBall.teamRuns).toBe(1);
        expect(noBall.rotatesOnRuns).toBe(false);
    });

    it('does not rotate on boundaries or other even scores', () => {
        expect(resolveDelivery({ runs: 0 }).rotatesOnRuns).toBe(false);
        expect(resolveDelivery({ runs: 2 }).rotatesOnRuns).toBe(false);
        expect(resolveDelivery({ runs: 4 }).rotatesOnRuns).toBe(false);
        expect(resolveDelivery({ runs: 6 }).rotatesOnRuns).toBe(false);
    });

    it('only wide and no-ball are illegal deliveries', () => {
        expect(resolveDelivery({ runs: 0 }).isLegal).toBe(true);
        expect(resolveDelivery({ runs: 2, runsFrom: 'bye' }).isLegal).toBe(true);
        expect(resolveDelivery({ runs: 1, runsFrom: 'leg_bye' }).isLegal).toBe(true);
        expect(resolveDelivery({ runs: 0, extraType: 'wide' }).isLegal).toBe(false);
        expect(resolveDelivery({ runs: 0, extraType: 'no_ball' }).isLegal).toBe(false);
    });

    it('credits the batsman only for runs off the bat on a legal ball or no-ball', () => {
        expect(resolveDelivery({ runs: 4 }).ballRuns).toBe(4);
        expect(resolveDelivery({ runs: 6, extraType: 'no_ball' }).ballRuns).toBe(6);
        expect(resolveDelivery({ runs: 2, extraType: 'wide' }).ballRuns).toBe(0);
        expect(resolveDelivery({ runs: 2, runsFrom: 'bye' }).ballRuns).toBe(0);
    });

    it('defaults to a legal delivery off the bat when extras are omitted', () => {
        expect(resolveDelivery({ runs: 3 })).toEqual(
            resolveDelivery({ runs: 3, extraType: null, runsFrom: 'bat' })
        );
    });
});
