import { Router } from "express";
import {
    getNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,
} from "../controllers/notification.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/').get(verifyJwt, getNotifications);
router.route('/unread-count').get(verifyJwt, getUnreadCount);
router.route('/read-all').post(verifyJwt, markAllNotificationsRead);
router.route('/:notificationId/read').patch(verifyJwt, markNotificationRead);

export default router;
