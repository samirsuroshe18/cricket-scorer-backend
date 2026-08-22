// Mirrors the `minlength` on User.password. Enforced explicitly in controllers
// because password writes use { validateBeforeSave: false }, which skips schema validators.
export const MIN_PASSWORD_LENGTH = 8;
