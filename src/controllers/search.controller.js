import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Organization } from '../models/organization.model.js';
import { Tournament } from '../models/tournament.model.js';

const asString = (value) => (typeof value === 'string' ? value : '');

// Every organization/tournament is searchable regardless of the caller's
// membership — there is no visibility/privacy concept on either model (see
// docs/api.md's search section for the decision). Login is required only
// because every other endpoint in this app is, not because the results
// themselves are sensitive.
export const search = catchAsync(async (req, res) => {
    const q = asString(req.query.q).trim();
    if (!q) {
        throw new ApiError(400, "SEARCH_QUERY_REQUIRED");
    }

    const [organizations, tournaments] = await Promise.all([
        Organization.find(
            { $text: { $search: q }, isDeleted: false },
            'name members',
        ),
        Tournament.find(
            { $text: { $search: q }, isDeleted: false },
            'name format status organization',
        ).populate('organization', 'name'),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        organizations: organizations.map((org) => ({
            id: org._id,
            name: org.name,
            memberCount: org.members.length,
        })),
        tournaments: tournaments.map((t) => ({
            id: t._id,
            name: t.name,
            organizationName: t.organization?.name ?? null,
            format: t.format,
            status: t.status,
        })),
    }, req.t("SEARCH_FETCHED")));
});
