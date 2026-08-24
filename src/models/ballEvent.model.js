import mongoose, {Schema} from "mongoose";
import { WICKET_TYPES } from "../utils/resolveStrike.js";

// The delivery *fault* only. `bye`/`leg_bye` are NOT faults — they describe who
// the runs belong to, which is `runsFrom` below. Keeping the two orthogonal is
// what lets a single ball be both a no-ball and go for byes.
const EXTRA_TYPES   = ['wide', 'no_ball'];
// Who the runs on this delivery are credited to.
const RUNS_FROM     = ['bat', 'bye', 'leg_bye'];

// Mirrors Inning.extras — typed instead of Mixed so this snapshot (duplicated
// on every ball, the highest-volume collection in the app) stays validated
// and doesn't carry an unpredictable/untyped field.
const extrasSnapshotSchema = new Schema(
  {
    wides:   { type: Number, default: 0, min: 0 },
    noBalls: { type: Number, default: 0, min: 0 },
    byes:    { type: Number, default: 0, min: 0 },
    legByes: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Snapshot of innings state BEFORE this ball was applied
// Used to restore state on undo — O(1) rollback
const preEventStateSchema = new Schema(
  {
    totalRuns:          { type: Number, required: true },
    wickets:            { type: Number, required: true },
    legalBalls:         { type: Number, required: true },
    totalBalls:         { type: Number, required: true },
    oversCompleted:     { type: Number, required: true },
    strikerId:          { type: Schema.Types.ObjectId },
    nonStrikerId:       { type: Schema.Types.ObjectId },
    currentBowlerId:    { type: Schema.Types.ObjectId },
    // Names are snapshotted, not re-derived by "swap back if strikeRotated" —
    // that shortcut holds only while rotation is a pure swap of the pair, and
    // breaks as soon as a dismissal *replaces* a batsman. Also lets an
    // idempotent replay rebuild this ball's strike with no Player lookup.
    strikerName:        { type: String },
    nonStrikerName:     { type: String },
    overTotalRuns:      { type: Number, required: true },
    overLegalDeliveries:{ type: Number, required: true },
    extrasSnapshot:     { type: extrasSnapshotSchema, default: () => ({}) },
    // The OVER's extras before this ball — without it, undoing a wide could
    // restore the over's runs but not its wide count.
    overExtrasSnapshot: { type: extrasSnapshotSchema, default: () => ({}) },
  },
  { _id: false }
);

const ballEventSchema = new Schema(
  {
    matchId:          { type: Schema.Types.ObjectId, ref: 'Match',   required: true },
    inningsId:        { type: Schema.Types.ObjectId, ref: 'Inning', required: true },
    overId:           { type: Schema.Types.ObjectId, ref: 'Over',    required: true },
    overNumber:       { type: Number, required: true },   // denormalized
    ballNumber:       { type: Number, required: true },   // within over
    absoluteBallSeq:  { type: Number, required: true },   // global seq in innings for undo

    strikerId:        { type: Schema.Types.ObjectId, ref: 'Player' },
    bowlerId:         { type: Schema.Types.ObjectId, ref: 'Player' },
    nonStrikerId:     { type: Schema.Types.ObjectId, ref: 'Player' },

    idempotencyKey:   { type: String, required: true },

    // `runs` is what the BATSMAN is credited with; `extras` is what goes to the
    // team without batsman credit. A delivery always adds runs + extras to the
    // innings total.
    runs:             { type: Number, required: true, min: 0, max: 6 },
    extras:           { type: Number, default: 0, min: 0 },
    extraType:        { type: String, enum: EXTRA_TYPES, default: null },
    runsFrom:         { type: String, enum: RUNS_FROM, default: 'bat' },

    isWicket:         { type: Boolean, default: false },
    wicketType:       { type: String, enum: WICKET_TYPES, default: null },
    dismissedPlayerId:{ type: Schema.Types.ObjectId, ref: 'Player' },
    dismissedPlayerName: { type: String },
    // The replacement, stored on the ball itself. preEventState holds only the
    // pair from *before* the delivery, so without these a wicket ball's strike
    // could not be rebuilt on undo or on an idempotent replay — the post-ball
    // pair contains someone who was not at the crease when it was bowled.
    // Both null on the final wicket.
    incomingBatsmanId:   { type: Schema.Types.ObjectId, ref: 'Player' },
    incomingBatsmanName: { type: String },

    isLegal:          { type: Boolean, required: true },  // extraType == null
    // True iff the striker AFTER this ball is the non-striker from before it.
    // Odd runs run and the end of an over each flip strike; both on the same
    // ball cancel out. See resolveDelivery.rotatesOnRuns.
    strikeRotated:    { type: Boolean, default: false },

    // State snapshot for O(1) undo
    preEventState:    { type: preEventStateSchema, required: true },
  },
  {
    timestamps: { createdAt: 'timestamp', updatedAt: false },
  }
);

// Dedupe on retry: replaying the same client-generated key must not append
// twice. Also serves match-scoped equality queries on its own — don't add a
// separate single-field index on `matchId`, it would be a redundant prefix.
ballEventSchema.index({ matchId: 1, idempotencyKey: 1 }, { unique: true });
// Primary undo index: latest ball in innings
ballEventSchema.index({ inningsId: 1, absoluteBallSeq: -1 });
// Over breakdown
ballEventSchema.index({ inningsId: 1, overNumber: 1, ballNumber: 1 });
// `strikerId`/`bowlerId` indexes deliberately omitted for now — nothing
// queries by them yet, and this is the highest-write-volume collection in the
// app. Add them back in the same change that ships the player-stats feature.

// Immutability guard — ball events should never be updated, only deleted on undo
ballEventSchema.pre('updateOne', function () {
  throw new Error('BallEvent documents are immutable. Use undo (delete) instead.');
});
ballEventSchema.pre('findOneAndUpdate', function () {
  throw new Error('BallEvent documents are immutable. Use undo (delete) instead.');
});

export const BallEvent = mongoose.model('BallEvent', ballEventSchema);