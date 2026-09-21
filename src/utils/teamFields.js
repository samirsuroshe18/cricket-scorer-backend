import ApiError from './ApiError.js';

export const MAX_TEAM_NAME_LENGTH = 50;
export const MAX_TEAM_SHORT_NAME_LENGTH = 5;

const asString = (value) => (typeof value === 'string' ? value : '');

// The name and short name of a team being created directly (POST /v1/team and
// POST /v1/organization/:orgId/teams). Length limits are checked here rather
// than left to Team's schema: a Mongoose ValidationError is not an ApiError,
// so errorHandler would report an over-long value as a 500. `body` may be
// undefined (Express leaves req.body unset when nothing was parsed). A blank
// short name comes back undefined so the field is stored as absent.
export const parseTeamFields = (body) => {
    const fields = body ?? {};

    const name = asString(fields.name).trim();
    if (!name) {
        throw new ApiError(400, "TEAM_NAME_REQUIRED");
    }
    if (name.length > MAX_TEAM_NAME_LENGTH) {
        throw new ApiError(400, "TEAM_NAME_TOO_LONG");
    }

    const shortName = asString(fields.shortName).trim();
    if (shortName.length > MAX_TEAM_SHORT_NAME_LENGTH) {
        throw new ApiError(400, "TEAM_SHORT_NAME_TOO_LONG");
    }

    return { name, shortName: shortName || undefined };
};
