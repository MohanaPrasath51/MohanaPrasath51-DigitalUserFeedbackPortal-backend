const express = require('express');
const router = express.Router();
const {
  submitFeedback,
  getAllFeedback,
  getFeedbackById,
  updateFeedback,
  deleteFeedback,
  getFeedbackStats,
  addMessage,
  requestChatAccess,
  grantChatAccess,
  getFeedbackAnalytics,
} = require('../controllers/feedbackController');
const { protect, adminOnly, adminOrTeam } = require('../middleware/authMiddleware');

router.post('/', protect, submitFeedback);
router.get('/', protect, getAllFeedback);
router.get('/stats', protect, adminOrTeam, getFeedbackStats);
router.get('/analytics', protect, adminOrTeam, getFeedbackAnalytics);
router.get('/:id', protect, getFeedbackById);
router.put('/:id', protect, updateFeedback);
router.delete('/:id', protect, deleteFeedback);
router.post('/:id/messages', protect, addMessage);
router.post('/:id/request-chat', protect, requestChatAccess);
router.post('/:id/grant-chat', protect, adminOnly, grantChatAccess);

module.exports = router;
