import mongoose, { Schema } from "mongoose";

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Derived from `name` by organization.controller.js on every write,
    // same convention as Player.nameLower (see that model's own comment on
    // why a schema hook isn't used instead — findOrCreate-style upserts
    // bypass document middleware).
    nameLower: { type: String, required: true, trim: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['owner', 'member'], required: true },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique per owner, same shape as Player's {createdBy, nameLower} — one
// owner can't create two organizations with the same name (case-insensitive
// via nameLower). Deliberately not global uniqueness: two different owners
// naming their club the same real-world name is expected, not a collision.
organizationSchema.index({ owner: 1, nameLower: 1 }, { unique: true });
// Supports "which organizations am I a member of" — GET /v1/organization
// and getMemberOrgIds (used by the widened GET /v1/team query).
organizationSchema.index({ 'members.user': 1 });

export const Organization = mongoose.model('Organization', organizationSchema);
