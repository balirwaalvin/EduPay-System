/**
 * Notification endpoints, available to every signed-in role.
 *
 * Previously only the teacher portal could read notifications, so HR,
 * accountants and administrators had no inbox at all.
 */
const express = require('express');
const router = express.Router();

const { authenticateToken, asyncHandler, HttpError } = require('../middleware');
const v = require('../services/validate');
const notify = require('../services/notifications');

router.use(authenticateToken);

router.get('/', asyncHandler(async (req, res) => {
    const [items, unread] = await Promise.all([
        notify.listForUser(req.user.id, {
            limit: req.query.limit,
            unreadOnly: v.bool(req.query.unreadOnly, false)
        }),
        notify.unreadCount(req.user.id)
    ]);
    res.json({ notifications: items, unreadCount: unread });
}));

router.get('/unread-count', asyncHandler(async (req, res) => {
    res.json({ unreadCount: await notify.unreadCount(req.user.id) });
}));

// Registered before the `:id` route so "read-all" is not read as an id.
router.put('/read-all', asyncHandler(async (req, res) => {
    const updated = await notify.markAllRead(req.user.id);
    res.json({ message: updated ? `${updated} notification(s) marked as read.` : 'No unread notifications.', updated });
}));

router.put('/:id/read', asyncHandler(async (req, res) => {
    const id = v.num(req.params.id, 'Notification id', { integer: true, min: 1 });
    const ok = await notify.markRead(id, req.user.id);
    if (!ok) throw new HttpError(404, 'Notification not found.', 'NOT_FOUND');
    res.json({ message: 'Notification marked as read.' });
}));

module.exports = router;
