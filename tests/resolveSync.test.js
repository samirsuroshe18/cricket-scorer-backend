import { resolveSyncDecision } from '../src/utils/resolveSync.js';

const KEY_A = 'a1111111-1111-1111-1111-111111111111';
const KEY_B = 'b2222222-2222-2222-2222-222222222222';
const KEY_C = 'c3333333-3333-3333-3333-333333333333';
const KEY_FOREIGN = 'f9999999-9999-9999-9999-999999999999';

describe('resolveSyncDecision', () => {
    describe('clean sync — server exactly where the client left it', () => {
        it('applies the whole batch when serverSeq === baseSeq', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 41,
                batchBallKeys: [KEY_A, KEY_B, KEY_C],
                serverKeysAhead: [],
            });

            expect(result).toEqual({ decision: 'apply', resumeAfterBallCount: 0 });
        });

        it('applies a batch of only bowler events with no balls at all', () => {
            const result = resolveSyncDecision({
                baseSeq: 12,
                serverSeq: 12,
                batchBallKeys: [],
                serverKeysAhead: [],
            });

            expect(result).toEqual({ decision: 'apply', resumeAfterBallCount: 0 });
        });

        it('applies from zero on a fresh innings', () => {
            const result = resolveSyncDecision({
                baseSeq: 0,
                serverSeq: 0,
                batchBallKeys: [KEY_A],
                serverKeysAhead: [],
            });

            expect(result).toEqual({ decision: 'apply', resumeAfterBallCount: 0 });
        });
    });

    describe('resume — a retry after a lost response mid-sync', () => {
        it('skips the server-confirmed prefix and resumes from the remainder', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 43,
                batchBallKeys: [KEY_A, KEY_B, KEY_C],
                serverKeysAhead: [KEY_A, KEY_B],
            });

            expect(result).toEqual({ decision: 'resume', resumeAfterBallCount: 2 });
        });

        it('resumes correctly when every ball in the batch already landed', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 44,
                batchBallKeys: [KEY_A, KEY_B, KEY_C],
                serverKeysAhead: [KEY_A, KEY_B, KEY_C],
            });

            expect(result).toEqual({ decision: 'resume', resumeAfterBallCount: 3 });
        });

        it('resumes past just one confirmed ball', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 42,
                batchBallKeys: [KEY_A, KEY_B, KEY_C],
                serverKeysAhead: [KEY_A],
            });

            expect(result).toEqual({ decision: 'resume', resumeAfterBallCount: 1 });
        });
    });

    describe('conflict — a second scorer moved the server past base', () => {
        it('rejects when the server holds a ball this client never queued', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 42,
                batchBallKeys: [KEY_A, KEY_B, KEY_C],
                serverKeysAhead: [KEY_FOREIGN],
            });

            expect(result).toEqual({ decision: 'conflict', reason: 'key_mismatch' });
        });

        it('rejects when the server is ahead by more balls than the batch has', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 45,
                batchBallKeys: [KEY_A, KEY_B],
                serverKeysAhead: [KEY_A, KEY_B, KEY_FOREIGN, KEY_FOREIGN],
            });

            expect(result).toEqual({ decision: 'conflict', reason: 'server_ahead_of_batch' });
        });

        it('rejects a batch with no ball events at all when the server is still ahead', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 42,
                batchBallKeys: [],
                serverKeysAhead: [KEY_FOREIGN],
            });

            expect(result).toEqual({ decision: 'conflict', reason: 'server_ahead_of_batch' });
        });

        it('rejects when the matching prefix breaks partway through', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 43,
                batchBallKeys: [KEY_A, KEY_B, KEY_C],
                serverKeysAhead: [KEY_A, KEY_FOREIGN],
            });

            expect(result).toEqual({ decision: 'conflict', reason: 'key_mismatch' });
        });
    });

    describe('conflict — someone undid a ball this client had confirmed', () => {
        it('rejects when serverSeq has gone backward relative to base', () => {
            const result = resolveSyncDecision({
                baseSeq: 41,
                serverSeq: 38,
                batchBallKeys: [KEY_A],
                serverKeysAhead: [],
            });

            expect(result).toEqual({ decision: 'conflict', reason: 'server_behind_base' });
        });

        it('rejects even when the batch itself would otherwise be fine', () => {
            const result = resolveSyncDecision({
                baseSeq: 10,
                serverSeq: 0,
                batchBallKeys: [],
                serverKeysAhead: [],
            });

            expect(result).toEqual({ decision: 'conflict', reason: 'server_behind_base' });
        });
    });

    describe('input contract', () => {
        it('throws on a non-integer baseSeq', () => {
            expect(() => resolveSyncDecision({ baseSeq: 1.5, serverSeq: 2 })).toThrow();
        });

        it('throws on a negative serverSeq', () => {
            expect(() => resolveSyncDecision({ baseSeq: 0, serverSeq: -1 })).toThrow();
        });

        it('defaults batchBallKeys/serverKeysAhead to empty arrays', () => {
            expect(() => resolveSyncDecision({ baseSeq: 5, serverSeq: 5 })).not.toThrow();
        });
    });
});
