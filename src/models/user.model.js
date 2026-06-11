import mongoose, { Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

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
        },

        otpVerifyTokenExpiry: {
            type: Date,
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