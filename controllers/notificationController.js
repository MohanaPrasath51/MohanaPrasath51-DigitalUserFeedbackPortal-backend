const Notification = require('../models/Notification');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/notifications - Get current user alerts
const getMyNotifications = asyncHandler(async (req, res) => {
  const alerts = await Notification.find({ recipient: req.user._id })
    .sort({ createdAt: -1 })
    .limit(20);
  res.json(alerts);
});

// PATCH /api/notifications/:id/read - Mark single as read
const readNotification = asyncHandler(async (req, res) => {
  const alert = await Notification.findById(req.params.id);
  if (!alert) return res.status(404).json({ message: 'Warning alert vanished.' });
  if (alert.recipient.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: 'Access denied: Cannot read someone else\'s notifications.' });
  }
  alert.isRead = true;
  await alert.save();
  res.json(alert);
});

// PATCH /api/notifications/read-all - Bulk mark as read
const readAllNotifications = asyncHandler(async (req, res) => {
  await Notification.updateMany({ recipient: req.user._id, isRead: false }, { isRead: true });
  res.json({ message: 'Mailbox cleared: Success.' });
});

module.exports = { getMyNotifications, readNotification, readAllNotifications };
