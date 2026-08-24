import { resolveUndo } from '../src/utils/resolveUndo.js';
import { resolveDelivery } from '../src/utils/resolveDelivery.js';
import { resolveBallOutcome } from '../src/utils/resolveOver.js';
import { resolveStrike } from '../src/utils/resolveStrike.js';

const STRIKER = '665f3b1c2d3e4f5a6b7c8d90';
const NON_STRIKER = '665f3b1c2d3e4f5a6b7c8d91';
const BOWLER = '665f3b1c2d3e4f5a6b7c8d94';
const INCOMING = '665f3b1c2d3e4f5a6b7c8d95';

const snapshot = (over = {}) => ({
    totalRuns: 24,
    wickets: 2,
    legalBalls: 11,
    totalBalls: 13,
    oversCompleted: 1,
    strikerId: STRIKER,
    strikerName: 'Rohit Sharma',
    nonStrikerId: NON_STRIKER,
    nonStrikerName: 'Ishan Kishan',
    currentBowlerId: BOWLER,
    overTotalRuns: 7,
    overLegalDeliveries: 5,
    extrasSnapshot: { wides: 2, noBalls: 1, byes: 3, legByes: 0 },
    overExtrasSnapshot: { wides: 1, noBalls: 0, byes: 3, legByes: 0 },
    ...over,
});

describe('resolveUndo', () => {
    it('restores every innings counter from the snapshot verbatim', () => {
        const { inning } = resolveUndo({ preEventState: snapshot() });

        expect(inning).toMatchObject({
            totalRuns: 24,
            wickets: 2,
            legalBalls: 11,
            totalBalls: 13,
            oversCompleted: 1,
            extras: { wides: 2, noBalls: 1, byes: 3, legByes: 0 },
            strikerId: STRIKER,
            strikerName: 'Rohit Sharma',
            nonStrikerId: NON_STRIKER,
            nonStrikerName: 'Ishan Kishan',
            currentBowlerId: BOWLER,
        });
    });

    it('restores the over counters and extras from the snapshot verbatim', () => {
        const { over } = resolveUndo({ preEventState: snapshot() });

        expect(over).toMatchObject({
            totalRuns: 7,
            legalDeliveries: 5,
            extras: { wides: 1, noBalls: 0, byes: 3, legByes: 0 },
        });
    });

    // The snapshot is a Mongoose subdocument on the ball being deleted; sharing
    // it with the innings being saved would be a live alias, not a restore.
    it('copies the extras buckets instead of aliasing the snapshot', () => {
        const pre = snapshot();
        const { inning, over } = resolveUndo({ preEventState: pre });

        inning.extras.wides = 99;
        over.extras.wides = 99;

        expect(pre.extrasSnapshot.wides).toBe(2);
        expect(pre.overExtrasSnapshot.wides).toBe(1);
    });

    it('defaults missing extras buckets to zero rather than undefined', () => {
        const { inning, over } = resolveUndo({
            preEventState: snapshot({ extrasSnapshot: undefined, overExtrasSnapshot: {} }),
        });

        expect(inning.extras).toEqual({ wides: 0, noBalls: 0, byes: 0, legByes: 0 });
        expect(over.extras).toEqual({ wides: 0, noBalls: 0, byes: 0, legByes: 0 });
    });

    describe('the three derived values', () => {
        it('decrements the over wicket count when the undone ball was a wicket', () => {
            const { over } = resolveUndo({
                preEventState: snapshot(),
                isWicket: true,
                overWickets: 2,
            });

            expect(over.wickets).toBe(1);
        });

        it('leaves the over wicket count alone on an ordinary delivery', () => {
            const { over } = resolveUndo({
                preEventState: snapshot(),
                isWicket: false,
                overWickets: 2,
            });

            expect(over.wickets).toBe(2);
        });

        it('floors the over wicket count at zero', () => {
            const { over } = resolveUndo({
                preEventState: snapshot(),
                isWicket: true,
                overWickets: 0,
            });

            expect(over.wickets).toBe(0);
        });

        // A ball cannot be bowled at an over that already has six legal
        // deliveries, so the over was open before whichever ball is being undone.
        it('always reopens the over', () => {
            expect(resolveUndo({ preEventState: snapshot() }).over.isComplete).toBe(false);
            expect(
                resolveUndo({ preEventState: snapshot({ overLegalDeliveries: 5 }) }).over.isComplete
            ).toBe(false);
        });

        // score-ball refuses a completed innings, so whatever the undone ball
        // did, the innings was in progress before it.
        it('always reopens the innings and clears the completion reason', () => {
            const { inning } = resolveUndo({
                preEventState: snapshot({ wickets: 9 }),
                isWicket: true,
                overWickets: 1,
            });

            expect(inning.status).toBe('in_progress');
            expect(inning.completionReason).toBeUndefined();
        });
    });

    // The point of the whole feature: apply a delivery the way score-ball does,
    // then undo it, and land back exactly where you started. Anything the
    // restore forgets shows up here as a diff.
    describe('round-trip against the scoring path', () => {
        const applyBall = (pre, { runs, extraType = null, runsFrom = 'bat', wicketType = null }) => {
            const delivery = resolveDelivery({ runs, extraType, runsFrom });
            const outcome = resolveBallOutcome({
                isLegal: delivery.isLegal,
                isWicket: Boolean(wicketType),
                preEventState: pre,
                totalOvers: 20,
            });
            const strikeRotated = delivery.rotatesOnRuns !== outcome.overComplete;

            const inning = {
                totalRuns: pre.totalRuns + delivery.teamRuns,
                wickets: pre.wickets + (wicketType ? 1 : 0),
                legalBalls: pre.legalBalls + (delivery.isLegal ? 1 : 0),
                totalBalls: pre.totalBalls + 1,
                oversCompleted: pre.oversCompleted + (outcome.overComplete ? 1 : 0),
                extras: {
                    wides: pre.extrasSnapshot.wides + delivery.buckets.wides,
                    noBalls: pre.extrasSnapshot.noBalls + delivery.buckets.noBalls,
                    byes: pre.extrasSnapshot.byes + delivery.buckets.byes,
                    legByes: pre.extrasSnapshot.legByes + delivery.buckets.legByes,
                },
                currentBowlerId: outcome.overComplete ? null : pre.currentBowlerId,
                ...resolveStrike({
                    strikerId: pre.strikerId,
                    strikerName: pre.strikerName,
                    nonStrikerId: pre.nonStrikerId,
                    nonStrikerName: pre.nonStrikerName,
                    rotated: strikeRotated,
                    dismissedId: wicketType ? pre.strikerId : null,
                    incomingId: wicketType ? INCOMING : null,
                    incomingName: wicketType ? 'Suryakumar Yadav' : null,
                }),
            };

            const over = {
                totalRuns: pre.overTotalRuns + delivery.teamRuns,
                legalDeliveries: pre.overLegalDeliveries + (delivery.isLegal ? 1 : 0),
                wickets: (wicketType ? 1 : 0),
                isComplete: outcome.overComplete,
                extras: {
                    wides: pre.overExtrasSnapshot.wides + delivery.buckets.wides,
                    noBalls: pre.overExtrasSnapshot.noBalls + delivery.buckets.noBalls,
                    byes: pre.overExtrasSnapshot.byes + delivery.buckets.byes,
                    legByes: pre.overExtrasSnapshot.legByes + delivery.buckets.legByes,
                },
            };

            return { inning, over, isWicket: Boolean(wicketType) };
        };

        const expectRoundTrip = (pre, ball) => {
            const applied = applyBall(pre, ball);
            const { inning, over } = resolveUndo({
                preEventState: pre,
                isWicket: applied.isWicket,
                overWickets: applied.over.wickets,
            });

            expect(inning.totalRuns).toBe(pre.totalRuns);
            expect(inning.wickets).toBe(pre.wickets);
            expect(inning.legalBalls).toBe(pre.legalBalls);
            expect(inning.totalBalls).toBe(pre.totalBalls);
            expect(inning.oversCompleted).toBe(pre.oversCompleted);
            expect(inning.extras).toEqual(pre.extrasSnapshot);
            expect(inning.strikerId).toBe(pre.strikerId);
            expect(inning.nonStrikerId).toBe(pre.nonStrikerId);
            expect(inning.currentBowlerId).toBe(pre.currentBowlerId);

            expect(over.totalRuns).toBe(pre.overTotalRuns);
            expect(over.legalDeliveries).toBe(pre.overLegalDeliveries);
            expect(over.extras).toEqual(pre.overExtrasSnapshot);
            expect(over.wickets).toBe(0);
            expect(over.isComplete).toBe(false);
        };

        it('round-trips a plain single (strike rotated)', () => {
            expectRoundTrip(snapshot({ overLegalDeliveries: 2 }), { runs: 1 });
        });

        it('round-trips a boundary', () => {
            expectRoundTrip(snapshot({ overLegalDeliveries: 2 }), { runs: 4 });
        });

        it('round-trips a wide (illegal, over does not advance)', () => {
            expectRoundTrip(snapshot({ overLegalDeliveries: 5 }), { runs: 0, extraType: 'wide' });
        });

        it('round-trips a no-ball that went for byes', () => {
            expectRoundTrip(snapshot({ overLegalDeliveries: 3 }), {
                runs: 2,
                extraType: 'no_ball',
                runsFrom: 'bye',
            });
        });

        it('round-trips leg-byes', () => {
            expectRoundTrip(snapshot({ overLegalDeliveries: 1 }), { runs: 3, runsFrom: 'leg_bye' });
        });

        // The bowler pointer is nulled when the over ends; the snapshot is the
        // only thing that brings it back.
        it('round-trips the ball that completes an over, restoring the bowler', () => {
            expectRoundTrip(snapshot({ overLegalDeliveries: 5 }), { runs: 0 });
        });

        it('round-trips a wicket, restoring the dismissed batsman to the crease', () => {
            const pre = snapshot({ overLegalDeliveries: 2 });
            const applied = applyBall(pre, { runs: 0, wicketType: 'caught' });

            expect(applied.inning.strikerId).toBe(INCOMING);

            const { inning } = resolveUndo({
                preEventState: pre,
                isWicket: true,
                overWickets: applied.over.wickets,
            });

            expect(inning.strikerId).toBe(STRIKER);
            expect(inning.strikerName).toBe('Rohit Sharma');
            expect(inning.wickets).toBe(pre.wickets);
        });

        // The awkward one: a wicket on the last ball of the over. The over ends
        // AND a batsman is replaced, so both halves of the restore have to fire.
        it('round-trips a wicket on the last ball of an over', () => {
            const pre = snapshot({ overLegalDeliveries: 5 });
            const applied = applyBall(pre, { runs: 0, wicketType: 'bowled' });

            expect(applied.over.isComplete).toBe(true);
            expect(applied.inning.currentBowlerId).toBeNull();

            const { inning, over } = resolveUndo({
                preEventState: pre,
                isWicket: true,
                overWickets: applied.over.wickets,
            });

            expect(inning.currentBowlerId).toBe(BOWLER);
            expect(inning.oversCompleted).toBe(pre.oversCompleted);
            expect(inning.strikerId).toBe(STRIKER);
            expect(over.isComplete).toBe(false);
            expect(over.legalDeliveries).toBe(5);
            expect(over.wickets).toBe(0);
        });

        it('round-trips the tenth wicket, reopening a completed innings', () => {
            const pre = snapshot({ wickets: 9, overLegalDeliveries: 2 });
            const applied = applyBall(pre, { runs: 0, wicketType: 'lbw' });

            expect(applied.inning.wickets).toBe(10);

            const { inning } = resolveUndo({
                preEventState: pre,
                isWicket: true,
                overWickets: applied.over.wickets,
            });

            expect(inning.wickets).toBe(9);
            expect(inning.status).toBe('in_progress');
            expect(inning.completionReason).toBeUndefined();
        });
    });
});
