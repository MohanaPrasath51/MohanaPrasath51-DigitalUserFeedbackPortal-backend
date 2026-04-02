const express = require('express');
const router = express.Router();
const { getMyNotifications, readNotification, readAllNotifications } = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, getMyNotifications);
router.patch('/read-all', protect, readAllNotifications);
router.patch('/:id/read', protect, readNotification);

module.exports = router;
