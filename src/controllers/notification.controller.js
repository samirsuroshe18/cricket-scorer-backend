import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Notification } from '../models/notification.model.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Same pagination convention as GET /v1/match/history — see that
// endpoint's own comment for why an enforced max rather than an unbounded
// `.find()`.
const getNotifications = catchAsync(async (req, res) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || DEFAULT_LIMIT;

    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new ApiError(400, "INVALID_PAGINATION", { params: { max: MAX_LIMIT } });
    }

    const filter = { recipient: req.user._id };

    const [notifications, total] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Notification.countDocuments(filter),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        notifications: notifications.map((notification) => ({
            notificationId: notification._id,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            data: notification.data ?? {},
            read: notification.read,
            createdAt: notification.createdAt,
        })),
        page,
        limit,
        total,
    }, req.t("NOTIFICATIONS_FETCHED")));
});

const getUnreadCount = catchAsync(async (req, res) => {
    const count = await Notification.countDocuments({ recipient: req.user._id, read: false });

    return res.status(200).json(new ApiResponse(200, {
        count,
    }, req.t("UNREAD_COUNT_FETCHED")));
});

const markNotificationRead = catchAsync(async (req, res) => {
    const { notificationId } = req.params;

    const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, recipient: req.user._id },
        { $set: { read: true } },
        { new: true }
    );
    if (!notification) {
        throw new ApiError(404, "NOTIFICATION_NOT_FOUND");
    }

    return res.status(200).json(new ApiResponse(200, {
        notificationId: notification._id,
        read: notification.read,
    }, req.t("NOTIFICATION_MARKED_READ")));
});

const markAllNotificationsRead = catchAsync(async (req, res) => {
    await Notification.updateMany(
        { recipient: req.user._id, read: false },
        { $set: { read: true } }
    );

    return res.status(200).json(new ApiResponse(200, {}, req.t("ALL_NOTIFICATIONS_MARKED_READ")));
});

export { getNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead };
