import fs from 'fs';

// multer has already staged the file to disk by the time a controller runs,
// so every early exit before uploadOnCloudinary (which deletes it itself) has
// to discard it — otherwise a rejected upload leaves a file behind.
// ApiError's `localFilePath` option (unlinked by errorHandler) only covers a
// thrown ApiError; a malformed id raises a Mongoose CastError with no such
// option, which is why controllers call this explicitly around the lookup.
export const discardStagedFile = async (file) => {
    if (file?.path) {
        await fs.promises.unlink(file.path).catch(() => {});
    }
};
