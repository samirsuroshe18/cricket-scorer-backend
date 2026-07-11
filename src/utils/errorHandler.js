import fs from 'fs';

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const localFilePath = err.localFilePath || null;

  if (localFilePath && fs.existsSync(localFilePath)) {
    try {
      fs.unlinkSync(localFilePath);
    } catch (fsErr) {
      console.error('Failed to delete local file:', fsErr);
    }
  }

  const t = typeof req.t === "function" ? req.t : (key) => key;
  const isKnownError = err.isApiError === true;
  const code = isKnownError ? err.message : "INTERNAL_SERVER_ERROR";

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