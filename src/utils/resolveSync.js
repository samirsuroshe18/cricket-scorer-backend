/**
 * Decides how — or whether — a sync batch's `ball`/`bowler` events may be
 * applied against an innings' current state. Pure and DB-free on purpose: the
 * decision has to be exercised by tests without a replica set, the same reason
 * resolveDelivery/resolveOver/resolveStrike/resolveUndo are pure.
 *
 * `serverSeq` is `Inning.totalBalls` — the highest `absoluteBallSeq` the
 * innings has. `baseSeq` is the client's `baseAbsoluteBallSeq`: the seq it
 * last confirmed. `batchBallKeys` is every `ball` event's `idempotencyKey` in
 * the batch, in order. `serverKeysAhead` is the `idempotencyKey` of every ball
 * the server holds beyond `baseSeq`, read in `absoluteBallSeq` order — its
 * length is exactly `serverSeq - baseSeq` when the caller supplies it.
 *
 * Three outcomes:
 *   - `serverSeq < baseSeq` — a delivery this client had confirmed has since
 *     been undone by someone else. Conflict.
 *   - `serverSeq === baseSeq` — apply the whole batch.
 *   - `serverSeq > baseSeq` — the server moved on. If the extra balls' keys
 *     match a prefix of this batch's ball keys, position for position, they
 *     are this client's own writes from a sync whose response was lost:
 *     resume past them. Any mismatch, or more server balls than the batch
 *     has ball events, means someone else wrote deliveries this client never
 *     queued: conflict.
 *
 * `resumeAfterBallCount` is a count of *ball* events, not a batch index — the
 * caller walks `events` and skips everything up to and including the
 * `resumeAfterBallCount`-th `ball` event (bowler events in that span are
 * skipped too; re-applying one at the boundary is a harmless no-op, so this
 * function does not need to special-case it).
 */
export const resolveSyncDecision = ({ baseSeq, serverSeq, batchBallKeys = [], serverKeysAhead = [] }) => {
    if (!Number.isInteger(baseSeq) || baseSeq < 0) {
        throw new Error('resolveSyncDecision requires an integer baseSeq >= 0');
    }
    if (!Number.isInteger(serverSeq) || serverSeq < 0) {
        throw new Error('resolveSyncDecision requires an integer serverSeq >= 0');
    }

    if (serverSeq < baseSeq) {
        return { decision: 'conflict', reason: 'server_behind_base' };
    }

    if (serverSeq === baseSeq) {
        return { decision: 'apply', resumeAfterBallCount: 0 };
    }

    const ahead = serverSeq - baseSeq;

    if (ahead > batchBallKeys.length) {
        return { decision: 'conflict', reason: 'server_ahead_of_batch' };
    }

    for (let i = 0; i < ahead; i += 1) {
        if (serverKeysAhead[i] !== batchBallKeys[i]) {
            return { decision: 'conflict', reason: 'key_mismatch' };
        }
    }

    return { decision: 'resume', resumeAfterBallCount: ahead };
};
