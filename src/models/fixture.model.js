import mongoose, { Schema } from "mongoose";

export const FIXTURE_STATUS = ['scheduled', 'bye', 'completed', 'unresolved'];

const fixtureSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    // 1-indexed. For round_robin/league, a round is one matchday of the
    // circle-method schedule. For knockout, round 1 is the first bracket
    // round and each later round is generated on demand — see
    // generateFixtures.js and fixture.controller.js.
    round: { type: Number, required: true, min: 1 },
    // Stable display/read order within a round.
    order: { type: Number, required: true, min: 0 },
    teamA: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    // Null only when isBye is true. There is no TBD/placeholder team
    // anywhere in this model — every fixture has two concrete teams (or one
    // team plus a bye) from the moment it's created; see docs/api.md's
    // Fixture section for why knockout rounds are generated on demand
    // instead of upfront with placeholders.
    teamB: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    isBye: { type: Boolean, default: false },
    status: { type: String, enum: FIXTURE_STATUS, default: 'scheduled' },
    // Set once POST .../fixtures/:fixtureId/start-match creates the real
    // Match for this fixture.
    match: { type: Schema.Types.ObjectId, ref: 'Match', default: null },
    // Null until the fixture resolves. Stays null for a round-robin/league
    // bye (no advancement concept there) and while status is 'unresolved'.
    winner: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
  },
  { timestamps: true }
);

// The schedule's own natural read order — every fixture list in this
// feature reads round-by-round, ordered within a round.
fixtureSchema.index({ tournament: 1, round: 1, order: 1 });

export const Fixture = mongoose.model('Fixture', fixtureSchema);
