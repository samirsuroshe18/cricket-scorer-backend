import mongoose, { Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";

// Arm and pace/spin folded into one field rather than kept independent,
// because that's how the game actually talks about a bowler ("left-arm
// spin"), not two facts a UI would have to recombine into a sentence.
// Deliberately stops at 2x2 rather than the fast/fast-medium/medium and
// off-break/leg-break/googly/orthodox/chinaman split a professional profile
// uses — a recreational bowler is unlikely to know which of five sub-styles
// they bowl, and a field most users mis-select is worse than one left blank.
export const BATTING_STYLES = ['right_handed', 'left_handed'];
export const BOWLING_STYLES = ['right_arm_pace', 'left_arm_pace', 'right_arm_spin', 'left_arm_spin'];

const userSchema = new Schema(
    {
        email: {
            required: true,
            type: String,
            lowercase: true,
            sparse: true,
            unique: true
        },

        password: {
            type: String,
            required: true,
            minlength: 8
        },

        refreshToken: {
            type: String,
        },

        isEmailVerified: {
            type: Boolean,
            default: false
        },

        emailOtp: {
            type: String,
            select: false
        },

        emailOtpExpiry: {
            type: Date,
            select: false
        },

        passwordChangedAt: Date,

        lastLoginAt: Date,

        // Profile
        fullName: {
            type: String,
            required: true,
            trim: true,
        },

        userName: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
        },

        photoUrl: {
            type: String
        },

        bio: {
            type: String,
            maxlength: 200
        },

        // Self-declared, on User rather than Player: a Player document is
        // frequently found-or-created by someone else naming a teammate, with
        // no consent step and no link back to any account. Putting a style a
        // person claims about themselves on a document someone else can create
        // for them is exactly the data-integrity complaint CricHeroes users
        // report most — see docs/api.md's update-profile section.
        battingStyle: {
            type: String,
            enum: BATTING_STYLES,
        },

        bowlingStyle: {
            type: String,
            enum: BOWLING_STYLES,
        },

        profileCompleted: {
            type: Boolean,
            default: false
        },

        // Notifications
        fcmToken: {
            type: String,
        },

        // Account Management
        accountStatus: {
            type: String,
            enum: ["active", "blocked", "suspended"],
            default: "active"
        },

        isDeleted: {
            type: Boolean,
            default: false,
            index: true
        },

        expireDocAfterSeconds: {
            type: Date,
        },

        otpVerifyToken: {
            type: String,
            select: false
        },

        otpVerifyTokenExpiry: {
            type: Date,
            select: false
        },

        language: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            enum: ['en', 'hi', 'mr'],
            default: 'en'
        },

        userType: {
            type: String,
            enum: ['player', 'organization'],
            default: 'player',
            required: true,
        },
    },
    { timestamps: true },
);

// Create TTL index manually (only applies to documents where `expireDocAfterSeconds` exists)
userSchema.index({ expireDocAfterSeconds: 1 }, { expireAfterSeconds: 0 });

//pre hooks allow us to do any operation before saving the data in database
//in pre hook the first parameter on which event you have to do the operation like save, validation, etc
userSchema.pre("save", async function () {
    if (!this.isModified("password")) return;

    this.password = await bcrypt.hash(this.password, 10);
});

//you can create your custom methods as well by using methods object
userSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

//jwt is a bearer token it means the person bear this token we give the access to that person its kind of chavi
userSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            userName: this.userName,
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY,
        },
    );
};

userSchema.methods.generateRefreshToken = function (expiry) {
    return jwt.sign(
        {
            _id: this._id,
            // jsonwebtoken's own `iat` is second-granularity, and this
            // payload otherwise carries nothing but `_id` — two refresh
            // tokens minted for the same user within the same wall-clock
            // second are otherwise byte-for-byte identical, defeating any
            // comparison meant to tell "the token already on record" apart
            // from "a freshly rotated one" (see refreshAccessToken's own
            // compare-and-swap, which relies on exactly that distinction).
            // A random id per issuance, never itself checked against
            // anything, is what actually guarantees uniqueness.
            jti: crypto.randomUUID(),
        },
        process.env.REFRESH_TOKEN_SECRET,
        {
            expiresIn: expiry ?? process.env.REFRESH_TOKEN_EXPIRY,
        },
    );
};

// Use async/await instead of next()
userSchema.pre(/^find/, async function () {
    if (!this.getOptions().includeSoftDeleted) {
        this.where({ isDeleted: false });
    }
    // No next() needed with async/await
});

export const User = mongoose.model("User", userSchema);