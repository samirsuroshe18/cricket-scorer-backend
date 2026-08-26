import {
    LEGAL_DELIVERIES_PER_OVER,
    completesOver,
    isSameBowler,
    resolveBallOutcome,
} from '../src/utils/resolveOver.js';

// Only the fields resolveBallOutcome reads; the real snapshot carries more.
const pre = ({ overLegalDeliveries = 0, wickets = 0, oversCompleted = 0, totalRuns = 0 }) => ({
    overLegalDeliveries,
    wickets,
    oversCompleted,
    totalRuns,
});

describe('completesOver', () => {
    it('fires on the transition from 5 legal deliveries to 6', () => {
        expect(completesOver({ isLegal: true, overLegalDeliveries: 5 })).toBe(true);
    });

    it.each([0, 1, 2, 3, 4])('does not fire at %i legal deliveries', (n) => {
        expect(completesOver({ isLegal: true, overLegalDeliveries: n })).toBe(false);
    });

    // The guard against double-counting oversCompleted: an over already at 6
    // must not complete again.
    it('does not fire again on an already-complete over', () => {
        expect(completesOver({ isLegal: true, overLegalDeliveries: 6 })).toBe(false);
    });

    // A wide off what would have been the last ball does not end the over.
    it('never fires on an illegal delivery, even at 5', () => {
        expect(completesOver({ isLegal: false, overLegalDeliveries: 5 })).toBe(false);
    });
});

describe('isSameBowler', () => {
    it('matches ObjectId-like values across string/object forms', () => {
        const id = '665f3b1c2d3e4f5a6b7c8d94';
        expect(isSameBowler(id, { toString: () => id })).toBe(true);
    });

    it('does not match different ids', () => {
        expect(isSameBowler('665f3b1c2d3e4f5a6b7c8d94', '665f3b1c2d3e4f5a6b7c8d95')).toBe(false);
    });

    // No previous over — over 1 of an innings restricts nobody.
    it.each([
        [null, '665f3b1c2d3e4f5a6b7c8d94'],
        ['665f3b1c2d3e4f5a6b7c8d94', null],
        [null, null],
        [undefined, undefined],
    ])('is false when either side is missing (%s, %s)', (a, b) => {
        expect(isSameBowler(a, b)).toBe(false);
    });
});

describe('resolveBallOutcome', () => {
    const outcome = (overrides = {}) => resolveBallOutcome({
        isLegal: true,
        isWicket: false,
        totalOvers: 20,
        preEventState: pre({}),
        ...overrides,
    });

    it('mid-over ball ends nothing and prompts for nobody', () => {
        expect(outcome({ preEventState: pre({ overLegalDeliveries: 3 }) })).toMatchObject({
            overComplete: false,
            inningsComplete: false,
            newBowlerRequired: false,
            completionReason: null,
        });
    });

    it('6th legal ball completes the over and requires a new bowler', () => {
        expect(outcome({ preEventState: pre({ overLegalDeliveries: 5 }) })).toMatchObject({
            overComplete: true,
            oversCompletedAfter: 1,
            inningsComplete: false,
            newBowlerRequired: true,
        });
    });

    it('a wide on the 6th legal ball leaves the over open', () => {
        expect(outcome({
            isLegal: false,
            preEventState: pre({ overLegalDeliveries: 5 }),
        })).toMatchObject({ overComplete: false, newBowlerRequired: false });
    });

    // The last over of the innings: the over ends, but there is no next over,
    // so no bowler is prompted for.
    it('completes the innings when the overs run out', () => {
        expect(outcome({
            totalOvers: 20,
            preEventState: pre({ overLegalDeliveries: 5, oversCompleted: 19 }),
        })).toMatchObject({
            overComplete: true,
            oversCompletedAfter: 20,
            oversDone: true,
            allOut: false,
            inningsComplete: true,
            newBowlerRequired: false,
            completionReason: 'overs_complete',
        });
    });

    it('does not end the innings one over short', () => {
        expect(outcome({
            totalOvers: 20,
            preEventState: pre({ overLegalDeliveries: 5, oversCompleted: 18 }),
        })).toMatchObject({
            oversCompletedAfter: 19,
            oversDone: false,
            newBowlerRequired: true,
        });
    });

    it('the 10th wicket ends the innings mid-over, with no over completion', () => {
        expect(outcome({
            isWicket: true,
            preEventState: pre({ overLegalDeliveries: 2, wickets: 9 }),
        })).toMatchObject({
            overComplete: false,
            wicketsAfter: 10,
            allOut: true,
            inningsComplete: true,
            newBowlerRequired: false,
            completionReason: 'all_out',
        });
    });

    it('the 10th wicket off the last ball of an over ends it without a bowler prompt', () => {
        expect(outcome({
            isWicket: true,
            preEventState: pre({ overLegalDeliveries: 5, wickets: 9 }),
        })).toMatchObject({
            overComplete: true,
            allOut: true,
            inningsComplete: true,
            newBowlerRequired: false,
            completionReason: 'all_out',
        });
    });

    // Both causes at once; being bowled out is what a scorecard reports.
    it('reports all_out when the innings is bowled out on the final ball of the final over', () => {
        expect(outcome({
            isWicket: true,
            totalOvers: 20,
            preEventState: pre({ overLegalDeliveries: 5, wickets: 9, oversCompleted: 19 }),
        })).toMatchObject({
            allOut: true,
            oversDone: true,
            completionReason: 'all_out',
        });
    });

    it('a wicket that is not the tenth ends nothing', () => {
        expect(outcome({
            isWicket: true,
            preEventState: pre({ overLegalDeliveries: 1, wickets: 4 }),
        })).toMatchObject({ wicketsAfter: 5, allOut: false, inningsComplete: false });
    });

    // Guards the replay path: derivation must not blow up without an over limit.
    it('never reports oversDone when totalOvers is missing', () => {
        expect(outcome({
            totalOvers: undefined,
            preEventState: pre({ overLegalDeliveries: 5, oversCompleted: 19 }),
        })).toMatchObject({ oversDone: false, newBowlerRequired: true });
    });

    it('LEGAL_DELIVERIES_PER_OVER is 6', () => {
        expect(LEGAL_DELIVERIES_PER_OVER).toBe(6);
    });
});

describe('resolveBallOutcome — target_achieved (innings 2 only)', () => {
    const chase = (overrides = {}) => resolveBallOutcome({
        isLegal: true,
        isWicket: false,
        teamRuns: 0,
        totalOvers: 20,
        inningsNumber: 2,
        target: 150,
        preEventState: pre({}),
        ...overrides,
    });

    it('ends the innings mid-over, the instant the total passes the target', () => {
        expect(chase({
            teamRuns: 4,
            preEventState: pre({ overLegalDeliveries: 2, totalRuns: 147 }),
        })).toMatchObject({
            overComplete: false,
            totalRunsAfter: 151,
            targetAchieved: true,
            inningsComplete: true,
            completionReason: 'target_achieved',
        });
    });

    it('does not fire one run short of the target', () => {
        expect(chase({
            teamRuns: 2,
            preEventState: pre({ overLegalDeliveries: 2, totalRuns: 147 }),
        })).toMatchObject({ targetAchieved: false, inningsComplete: false });
    });

    it('fires on exactly reaching the target — conceding it ties, passing it wins', () => {
        expect(chase({
            teamRuns: 3,
            preEventState: pre({ overLegalDeliveries: 2, totalRuns: 147 }),
        })).toMatchObject({ totalRunsAfter: 150, targetAchieved: true, inningsComplete: true });
    });

    it('never fires in innings 1, even with a target value present', () => {
        expect(chase({
            inningsNumber: 1,
            teamRuns: 10,
            preEventState: pre({ overLegalDeliveries: 2, totalRuns: 147 }),
        })).toMatchObject({ targetAchieved: false, inningsComplete: false });
    });

    it('never fires with no target set', () => {
        expect(chase({
            target: null,
            teamRuns: 10,
            preEventState: pre({ overLegalDeliveries: 2, totalRuns: 147 }),
        })).toMatchObject({ targetAchieved: false, inningsComplete: false });
    });

    // The winning run and the tenth wicket falling on the same ball — target
    // wins, because the chase ends the instant the total passes the target,
    // whatever the rest of that ball also did.
    it('takes precedence over all_out when both fire on the same ball', () => {
        expect(chase({
            isWicket: true,
            teamRuns: 4,
            preEventState: pre({ overLegalDeliveries: 2, totalRuns: 147, wickets: 9 }),
        })).toMatchObject({
            targetAchieved: true,
            allOut: true,
            inningsComplete: true,
            completionReason: 'target_achieved',
        });
    });

    // The winning boundary landing on what would also be the last ball of the
    // last over — target wins over oversDone for the same reason.
    it('takes precedence over overs_complete when both fire on the same ball', () => {
        expect(chase({
            teamRuns: 4,
            preEventState: pre({ overLegalDeliveries: 5, totalRuns: 147, oversCompleted: 19 }),
        })).toMatchObject({
            targetAchieved: true,
            oversDone: true,
            inningsComplete: true,
            completionReason: 'target_achieved',
        });
    });
});
