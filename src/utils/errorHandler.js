import fs from 'fs';

export const errorHandler = (err, req, res, next) => {
  // A malformed :matchId (or any other ObjectId-shaped route/body value
  // Mongoose casts before running the query) throws this synchronously from
  // deep inside the query layer, not from anything that ever calls
  // ApiError — every route with an id in its path is exposed to it, and
  // without this it fell through to the generic 500 below, indistinguishable
  // from a genuinely unexpected server error. It is exactly a bad-input
  // problem, not a server one.
  const isInvalidObjectId = err.name === 'CastError' && err.kind === 'ObjectId';

  const statusCode = isInvalidObjectId ? 400 : (err.statusCode || 500);
  const localFilePath = err.localFilePath || null;

  if (localFilePath && fs.existsSync(localFilePath)) {
    try {
      fs.unlinkSync(localFilePath);
    } catch (fsErr) {
      console.error('Failed to delete local file:', fsErr);
    }
  }

  const t = typeof req.t === "function" ? req.t : (key) => key;
  const isKnownError = err.isApiError === true || isInvalidObjectId;
  const code = isInvalidObjectId
    ? "INVALID_ID"
    : (isKnownError ? err.message : "INTERNAL_SERVER_ERROR");

  if (!isKnownError) console.error(err);

  return res.status(statusCode).json({
    statusCode,
    code,
    message: t(code, err.params || {})
  });

  // req.t("ACCOUNT_STATUS_ISSUE", {
  //   status: req.t(`ACCOUNT_STATUS.${user.accountStatus}`),
  // })
};