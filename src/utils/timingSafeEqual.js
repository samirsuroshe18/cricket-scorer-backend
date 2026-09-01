import crypto from "crypto";

// Comparing a secret value (an OTP, a hashed reset token) with a plain !==
// leaks timing information proportional to how many leading bytes match —
// crypto.timingSafeEqual is the standard defense. It throws outright on
// mismatched buffer lengths rather than comparing them, so the length check
// below is a fast-path guard, not a shortcut around it: a length mismatch is
// never the secret being protected here (an OTP is always 6 digits, a
// SHA-256 hex digest is always 64 chars), only the value is.
export const timingSafeEqualString = (a, b) => {
    const bufA = Buffer.from(String(a ?? ""));
    const bufB = Buffer.from(String(b ?? ""));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};
