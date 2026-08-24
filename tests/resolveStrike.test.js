import { resolveStrike, WICKET_TYPES, DISMISSED_BATSMEN } from '../src/utils/resolveStrike.js';

// Two batsmen at the crease and one waiting, named so the assertions read like
// a scorecard rather than like ids.
const ROHIT = { id: 'p1', name: 'Rohit' };
const ISHAN = { id: 'p2', name: 'Ishan' };
const SURYA = { id: 'p3', name: 'Surya' };

const crease = (striker, nonStriker) => ({
    strikerId: striker.id,
    strikerName: striker.name,
    nonStrikerId: nonStriker.id,
    nonStrikerName: nonStriker.name,
});

const at = (pair) => [pair.strikerName, pair.nonStrikerName];

describe('resolveStrike', () => {
    describe('without a dismissal it is a plain swap', () => {
        it('leaves the pair alone when the ball did not rotate', () => {
            expect(at(resolveStrike({ ...crease(ROHIT, ISHAN), rotated: false })))
                .toEqual(['Rohit', 'Ishan']);
        });

        it('swaps both ends when it did', () => {
            expect(at(resolveStrike({ ...crease(ROHIT, ISHAN), rotated: true })))
                .toEqual(['Ishan', 'Rohit']);
        });

        // The invariant the non-wicket contract rests on.
        it('makes the new striker the old non-striker whenever rotated', () => {
            const before = crease(ROHIT, ISHAN);
            const after = resolveStrike({ ...before, rotated: true });
            expect(after.strikerId).toBe(before.nonStrikerId);
            expect(after.nonStrikerId).toBe(before.strikerId);
        });
    });

    describe('a dismissal substitutes by player, not by end', () => {
        // Bowled/caught/lbw/stumped/hit-wicket: striker out, no runs, mid-over.
        it('puts the incoming batsman on strike when the striker is out mid-over', () => {
            expect(at(resolveStrike({
                ...crease(ROHIT, ISHAN),
                rotated: false,
                dismissedId: ROHIT.id,
                incomingId: SURYA.id,
                incomingName: SURYA.name,
            }))).toEqual(['Surya', 'Ishan']);
        });

        // The case worth reading twice: a wicket off the last ball of the over
        // does NOT hand the new batsman strike.
        it('sends the incoming batsman to the non-striker end when the over also ended', () => {
            expect(at(resolveStrike({
                ...crease(ROHIT, ISHAN),
                rotated: true,
                dismissedId: ROHIT.id,
                incomingId: SURYA.id,
                incomingName: SURYA.name,
            }))).toEqual(['Ishan', 'Surya']);
        });

        it('keeps the striker on strike when the non-striker is run out', () => {
            expect(at(resolveStrike({
                ...crease(ROHIT, ISHAN),
                rotated: false,
                dismissedId: ISHAN.id,
                incomingId: SURYA.id,
                incomingName: SURYA.name,
            }))).toEqual(['Rohit', 'Surya']);
        });

        // Run out going for a second: they crossed, so the survivor faces.
        it('leaves the survivor on strike when the striker is run out after crossing', () => {
            expect(at(resolveStrike({
                ...crease(ROHIT, ISHAN),
                rotated: true,
                dismissedId: ROHIT.id,
                incomingId: SURYA.id,
                incomingName: SURYA.name,
            }))).toEqual(['Ishan', 'Surya']);
        });

        // Substituting by end instead of by player would put Surya at the wrong
        // end here — this is the assertion that pins the ordering down.
        it('replaces the dismissed player even after rotation moved them', () => {
            const after = resolveStrike({
                ...crease(ROHIT, ISHAN),
                rotated: true,
                dismissedId: ISHAN.id,
                incomingId: SURYA.id,
                incomingName: SURYA.name,
            });
            expect(at(after)).toEqual(['Surya', 'Rohit']);
            expect(after.strikerId).toBe(SURYA.id);
        });
    });

    describe('the final wicket', () => {
        it('empties the dismissed end when nobody is left to come in', () => {
            const after = resolveStrike({
                ...crease(ROHIT, ISHAN),
                rotated: false,
                dismissedId: ROHIT.id,
            });
            expect(after.strikerId).toBeNull();
            expect(after.strikerName).toBeNull();
            expect(after.nonStrikerName).toBe('Ishan');
        });
    });

    it('compares ids loosely so Mongo ObjectIds match their string form', () => {
        const objectIdish = { toString: () => 'p1' };
        const after = resolveStrike({
            ...crease(ROHIT, ISHAN),
            dismissedId: objectIdish,
            incomingId: SURYA.id,
            incomingName: SURYA.name,
        });
        expect(after.strikerName).toBe('Surya');
    });

    it('leaves the pair untouched if the dismissed player is not at the crease', () => {
        expect(at(resolveStrike({
            ...crease(ROHIT, ISHAN),
            dismissedId: 'someone-else',
            incomingId: SURYA.id,
            incomingName: SURYA.name,
        }))).toEqual(['Rohit', 'Ishan']);
    });

    it('scopes v1 to six dismissal types and two ends', () => {
        expect(WICKET_TYPES).toEqual(
            ['bowled', 'caught', 'lbw', 'run_out', 'stumped', 'hit_wicket']
        );
        expect(WICKET_TYPES).not.toContain('obstructing');
        expect(WICKET_TYPES).not.toContain('timed_out');
        expect(DISMISSED_BATSMEN).toEqual(['striker', 'non_striker']);
    });
});
