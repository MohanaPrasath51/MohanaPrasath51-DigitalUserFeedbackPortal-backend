const Feedback = require('../models/Feedback');
const Notification = require('../models/Notification');
const Admin = require('../models/Admin');
const asyncHandler = require('../utils/asyncHandler');
const mongoose = require('mongoose');

// Helper: Validate MongoDB ID Edge Case
const validateId = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error(`Malformed ID: ${id}`);
    error.status = 400;
    throw error;
  }
};


const VALID_DEPARTMENTS = [
  'General Support',
  'NMC (Internet Issues)',
  'Electrical Team',
  'IT Support',
  'Campus Maintenance'
];

// POST /api/feedback - Submit new feedback
const submitFeedback = asyncHandler(async (req, res) => {
  const { title, description, category, priority, department, attachments } = req.body;

  // Edge Case: Minimum content verification
  if (!title || title.length < 5) {
    return res.status(400).json({ message: 'Title is too short. Minimum 5 characters required.' });
  }
  if (!description || description.length < 10) {
    return res.status(400).json({ message: 'Description is too vague. Minimum 10 characters required.' });
  }

  // Edge Case: Invalid Department detection
  if (department && !VALID_DEPARTMENTS.includes(department)) {
    return res.status(400).json({ message: 'Invalid destination department.' });
  }

  // --- Smart Merging: Detect Similar Issues ---
  const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'with', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'by', 'this', 'that', 'from', 'it', 'my', 'the', 'my', 'has', 'have', 'been', 'there']);
  
  const extractWords = (str) => {
    const words = (str || '').toLowerCase().match(/\w+/g) || [];
    return new Set(words.filter(w => w.length > 2 && !STOP_WORDS.has(w)));
  };

  const calculateJaccard = (setA, setB) => {
    if (setA.size === 0 || setB.size === 0) return 0;
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
  };

  const newTitleWords = extractWords(title);
  const newDescWords = extractWords(description);

  // Search for recent identical or highly similar issues in the same department
  const recentFeedbacks = await Feedback.find({
    department,
    status: { $in: ['pending', 'in-review'] },
    isDuplicate: { $ne: true },
    createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
  });

  let bestMatch = null;
  let highestSimilarity = 0;

  for (const fb of recentFeedbacks) {
    const fbTitleWords = extractWords(fb.title);
    const fbDescWords = extractWords(fb.description);

    const titleSim = calculateJaccard(newTitleWords, fbTitleWords);
    const descSim = calculateJaccard(newDescWords, fbDescWords);

    // Title is a stronger indicator of a duplicate issue
    const combinedSim = (titleSim * 0.7) + (descSim * 0.3);

    // If similarity > 45%, we consider it a duplicate
    if (combinedSim > highestSimilarity && combinedSim >= 0.45) {
      highestSimilarity = combinedSim;
      bestMatch = fb;
    }
  }

  let finalIsDuplicate = false;
  let finalDuplicateOf = null;

  if (bestMatch) {
    finalIsDuplicate = true;
    finalDuplicateOf = bestMatch._id;
  }
  // --- End Smart Merging ---

  const feedback = await Feedback.create({
    title,
    description,
    category,
    priority,
    department,
    attachments: attachments || [],
    submittedBy: req.user._id,
    isDuplicate: finalIsDuplicate,
    duplicateOf: finalDuplicateOf,
  });

  if (bestMatch) {
    bestMatch.duplicateCount = (bestMatch.duplicateCount || 0) + 1;
    await bestMatch.save();
  }

  res.status(201).json(feedback);
});

// GET /api/feedback - Logic for specific user permissions
const getAllFeedback = asyncHandler(async (req, res) => {
  let feedbackList;

  if (req.user.role === 'admin') {
    feedbackList = await Feedback.find({ isDuplicate: { $ne: true } })
      .populate('submittedBy', 'name email username')
      .populate('resolvedBy', 'name email department role')
      .sort({ createdAt: -1 });
  } else if (req.user.role === 'team') {
    feedbackList = await Feedback.find({
      department: req.user.department,
      isDuplicate: { $ne: true }
    })
      .populate('submittedBy', 'name email username')
      .populate('resolvedBy', 'name email department role')
      .sort({ createdAt: -1 });
  } else {
    feedbackList = await Feedback.find({ submittedBy: req.user._id })
      .populate('resolvedBy', 'name email department role')
      .sort({ createdAt: -1 });
  }

  res.json(feedbackList);
});

// GET /api/feedback/:id - Get single feedback
const getFeedbackById = asyncHandler(async (req, res) => {
  validateId(req.params.id);
  const feedback = await Feedback.findById(req.params.id)
    .populate('submittedBy', 'name email username')
    .populate('resolvedBy', 'name email department role')
    .populate('messages.senderId', 'name email department role');

  if (!feedback) {
    return res.status(404).json({ message: 'Feedback report not present in archives.' });
  }

  const isOwner = feedback.submittedBy._id.toString() === req.user._id.toString();
  const isAdmin = req.user.role === 'admin';
  const isTeam = req.user.role === 'team' && feedback.department === req.user.department;

  if (!isAdmin && !isTeam && !isOwner) {
    return res.status(403).json({ message: 'Structural access denied.' });
  }

  res.json(feedback);
});

// PUT /api/feedback/:id - Logic for State Transitions and Resolution Requirements
const updateFeedback = asyncHandler(async (req, res) => {
  validateId(req.params.id);
  const { status, adminResponse, priority, department, title, description, category } = req.body;

  const feedback = await Feedback.findById(req.params.id);
  if (!feedback) {
    return res.status(404).json({ message: 'Target record lost or deleted.' });
  }

  // Edge Case: Immutable state enforcement
  if (feedback.status === 'resolved') {
    return res.status(403).json({ message: 'Finalized records are immutable.' });
  }

  const isAdmin = req.user.role === 'admin' && req.user.isAdminCollection;
  const isTeam = req.user.role === 'team' && feedback.department === req.user.department;
  const isOwner = feedback.submittedBy.toString() === req.user._id.toString();

  if (!isAdmin && !isTeam && !isOwner) {
    return res.status(403).json({ message: 'Privilege escalation detected. Access denied.' });
  }

  // ONLY MAIN ADMIN (authenticated in Admin collection) can provide official responses or change status
  const canModifyCoreFields = isAdmin;

  if (!canModifyCoreFields && (status || adminResponse !== undefined || priority || department)) {
    return res.status(403).json({ message: 'Restricted: Only Main Admin can resolve or modify official responses.' });
  }

  // Field updates with permission checks
  if (status && canModifyCoreFields) {
    feedback.status = status;
    if (status === 'resolved') {
      feedback.resolvedBy = req.user._id;
      feedback.resolvedAt = Date.now();

      // AUTO-NOTIFICATION: RESOLUTION
      await Notification.create({
        recipient: feedback.submittedBy,
        onModel: 'User',
        type: 'status_update',
        title: 'Report Strategy: Resolved',
        message: `Your feedback regarding "${feedback.title}" has been officially resolved.`,
        feedbackId: feedback._id
      });
    }
  }

  if (adminResponse !== undefined && canModifyCoreFields) {
    feedback.adminResponse = adminResponse;
    feedback.resolvedBy = req.user._id;

    // Trigger Notification for Admin Reply
    await Notification.create({
      recipient: feedback.submittedBy,
      onModel: 'User',
      type: 'new_reply',
      title: 'Portal: Admin Response',
      message: `The administration has provided an official reply for your submission: "${feedback.title}".`,
      feedbackId: feedback._id
    });

    if (adminResponse && adminResponse.trim()) {
      feedback.messages.push({
        senderId: req.user._id,
        senderType: req.user.role === 'team' ? 'Team' : 'Admin',
        content: adminResponse.trim(),
        createdAt: Date.now()
      });
    }
  }

  if (priority && canModifyCoreFields) feedback.priority = priority;
  if (department && isAdmin) {
    if (VALID_DEPARTMENTS.includes(department)) feedback.department = department;
  }

  // Owners can edit only while pending
  if (isOwner && feedback.status === 'pending') {
    if (title) feedback.title = title;
    if (description) feedback.description = description;
    if (category) feedback.category = category;
  }

  feedback.updatedAt = Date.now();
  await feedback.save();

  // --- Smart Merging: Cascade updates to duplicates ---
  if (canModifyCoreFields && (status || adminResponse !== undefined)) {
    const duplicates = await Feedback.find({ duplicateOf: feedback._id, status: { $ne: 'resolved' } });

    for (const dup of duplicates) {
      let changed = false;
      if (status && dup.status !== status) {
        dup.status = status;
        changed = true;
        if (status === 'resolved') {
          dup.resolvedBy = req.user._id;
          dup.resolvedAt = Date.now();
          // Notify duplicate author
          await Notification.create({
            recipient: dup.submittedBy,
            onModel: 'User',
            type: 'status_update',
            title: 'Report Strategy: Resolved (Merged Case)',
            message: `The primary case for your merged submission "${dup.title}" has been resolved.`,
            feedbackId: dup._id
          });
        }
      }

      if (adminResponse !== undefined) {
        dup.adminResponse = adminResponse;
        dup.resolvedBy = req.user._id;
        
        if (adminResponse && adminResponse.trim()) {
          dup.messages.push({
            senderId: req.user._id,
            senderType: req.user.role === 'team' ? 'Team' : 'Admin',
            content: adminResponse.trim(),
            createdAt: Date.now()
          });
        }
        changed = true;

        await Notification.create({
          recipient: dup.submittedBy,
          onModel: 'User',
          type: 'new_reply',
          title: 'Portal: Admin Response (Merged Case)',
          message: `The administration updated the main case for your submission: "${dup.title}".`,
          feedbackId: dup._id
        });
      }

      if (changed) {
        dup.updatedAt = Date.now();
        await dup.save();
      }
    }
  }
  // --- End Cascade ---

  await feedback.populate([
    { path: 'submittedBy', select: 'name email username' },
    { path: 'resolvedBy', select: 'name email department role' },
    { path: 'messages.senderId', select: 'name email department role' }
  ]);

  const io = req.app.get('io');
  if (io && adminResponse !== undefined && canModifyCoreFields) {
    const newMsg = feedback.messages[feedback.messages.length - 1];
    if (newMsg) {
      io.to(req.params.id).emit('receive_message', newMsg);
    }
  }

  res.json(feedback);
});

// DELETE /api/feedback/:id
const deleteFeedback = asyncHandler(async (req, res) => {
  validateId(req.params.id);
  const feedback = await Feedback.findById(req.params.id);
  if (!feedback) {
    return res.status(404).json({ message: 'Record not found.' });
  }

  const isAdmin = req.user.role === 'admin';
  const isOwner = feedback.submittedBy.toString() === req.user._id.toString();

  if (feedback.status === 'resolved') {
    return res.status(403).json({ message: 'Archive integrity: Resolved cases cannot be deleted.' });
  }

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ message: 'Deletion authority required.' });
  }

  await feedback.deleteOne();
  res.json({ message: 'Record purged successfully.' });
});

const getFeedbackStats = asyncHandler(async (req, res) => {
  const isSuperAdmin = req.user.role === 'admin';
  const filter = isSuperAdmin ? { isDuplicate: { $ne: true } } : { department: req.user.department, isDuplicate: { $ne: true } };

  const total = await Feedback.countDocuments(filter);
  const pending = await Feedback.countDocuments({ ...filter, status: 'pending' });
  const inReview = await Feedback.countDocuments({ ...filter, status: 'in-review' });
  const resolved = await Feedback.countDocuments({ ...filter, status: 'resolved' });

  res.json({ total, pending, inReview, resolved });
});

// POST /api/feedback/:id/messages
const addMessage = asyncHandler(async (req, res) => {
  validateId(req.params.id);
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ message: 'Message cannot be empty.' });
  }

  const feedback = await Feedback.findById(req.params.id);
  if (!feedback) return res.status(404).json({ message: 'Feedback not found.' });

  // Distinguish between Admin collection users and standard Users
  // In our middleware, Admin users coming from custom JWT won't have the same structure as Firebase users
  const isAdminUser = req.user.role === 'admin' && req.user.isAdminCollection;
  const isTeamMember = req.user.role === 'team' && req.user.isAdminCollection;
  const isOwner = feedback.submittedBy.toString() === req.user._id.toString();

  // New Rule: Team members can chat ONLY if permitted by Main Admin for this specific feedback
  const isPermittedTeam = isTeamMember && feedback.permittedTeamMembers?.some(id => id.toString() === req.user._id.toString());

  if (!isAdminUser && !isOwner && !isPermittedTeam) {
    const msg = isTeamMember ? 'Secure: You lack valid chat authorization for this case.' : 'Only report owner or platform admin can participate in this chat.';
    return res.status(403).json({ message: msg });
  }

  if (feedback.status === 'resolved') {
    return res.status(403).json({ message: 'Chat is locked for resolved cases.' });
  }

  const newMessage = {
    senderId: req.user._id,
    senderType: isAdminUser ? 'Admin' : (isTeamMember ? 'Team' : 'User'),
    content: content.trim(),
    createdAt: Date.now()
  };

  feedback.messages.push(newMessage);
  feedback.updatedAt = Date.now();

  // Trigger Notifications
  if (isAdminUser) {
    await Notification.create({
      recipient: feedback.submittedBy,
      onModel: 'User',
      type: 'new_reply',
      title: 'New Support Message',
      message: `Admin responded to "${feedback.title}": ${content.substring(0, 30)}...`,
      feedbackId: feedback._id
    });
    if (feedback.status === 'pending') feedback.status = 'in-review';
  } else if (isPermittedTeam) {
    if (feedback.resolvedBy) {
      await Notification.create({
        recipient: feedback.resolvedBy,
        onModel: 'Admin',
        type: 'new_reply',
        title: `Team Update: ${feedback.title.substring(0, 15)}`,
        message: `${req.user.name} posted a team message: ${content.substring(0, 30)}...`,
        feedbackId: feedback._id
      });
    } else {
      const admins = await Admin.find({ role: 'admin' });
      for (const adm of admins) {
        await Notification.create({
          recipient: adm._id,
          onModel: 'Admin',
          type: 'new_reply',
          title: `Team update on #${feedback._id.toString().substring(19)}`,
          message: `${req.user.name} updated the thread: ${content.substring(0, 30)}...`,
          feedbackId: feedback._id
        });
      }
    }
  } else {
    // Notify Admin when the User (owner) responds
    if (feedback.resolvedBy) {
      await Notification.create({
        recipient: feedback.resolvedBy,
        onModel: 'Admin',
        type: 'new_reply',
        title: 'User Responded',
        message: `The user commented on "${feedback.title}": ${content.substring(0, 30)}...`,
        feedbackId: feedback._id
      });
    } else {
      const admins = await Admin.find({ role: 'admin' });
      for (const adm of admins) {
        await Notification.create({
          recipient: adm._id,
          onModel: 'Admin',
          type: 'new_reply',
          title: 'User Comment Alert',
          message: `Owner commented on "${feedback.title}": ${content.substring(0, 30)}...`,
          feedbackId: feedback._id
        });
      }
    }
  }

  await feedback.save();

  // Re-populate to ensure frontend gets full sender details immediately
  const populatedFeedback = await Feedback.findById(feedback._id)
    .populate('messages.senderId', 'name email department role');

  const savedMsg = populatedFeedback.messages[populatedFeedback.messages.length - 1];

  const io = req.app.get('io');
  if (io) {
    io.to(req.params.id).emit('receive_message', savedMsg);
  }

  res.status(201).json(savedMsg);
});

// POST /api/feedback/:id/request-chat
const requestChatAccess = asyncHandler(async (req, res) => {
  const feedback = await Feedback.findById(req.params.id);
  if (!feedback) return res.status(404).json({ message: 'Feedback not found.' });

  if (req.user.role !== 'team') {
    return res.status(403).json({ message: 'Authorization error: Only Team agents can request chat keys.' });
  }

  if (feedback.chatAccessRequests.includes(req.user._id)) {
    return res.status(400).json({ message: 'Key Request Protocol: Already in queue.' });
  }

  feedback.chatAccessRequests.push(req.user._id);
  await feedback.save();

  // Notify ALL Main Admins about the request
  const admins = await Admin.find({ role: 'admin' });
  for (const adm of admins) {
    await Notification.create({
      recipient: adm._id,
      onModel: 'Admin',
      type: 'system',
      title: 'Chat Access Requested',
      message: `${req.user.name} (${feedback.department}) is requesting chat permission for case #${feedback._id.toString().substring(19)}.`,
      feedbackId: feedback._id
    });
  }

  res.json({ message: 'Chat key requested: Awaiting admin authorization.' });
});

// POST /api/feedback/:id/grant-chat
const grantChatAccess = asyncHandler(async (req, res) => {
  const { userId } = req.body;
  const feedback = await Feedback.findById(req.params.id);
  if (!feedback) return res.status(404).json({ message: 'Feedback not found.' });

  // Ensure we are Main Admin (handled by adminOnly middleware in routes)
  if (!feedback.permittedTeamMembers.includes(userId)) {
    feedback.permittedTeamMembers.push(userId);
  }

  // Remove from requests list
  feedback.chatAccessRequests = feedback.chatAccessRequests.filter(id => id.toString() !== userId.toString());
  await feedback.save();

  // Notify the Team Member
  await Notification.create({
    recipient: userId,
    onModel: 'Admin',
    type: 'system',
    title: 'Vault Key Issued',
    message: `Admin granted you chat access for feedback: "${feedback.title}".`,
    feedbackId: feedback._id
  });

  res.json({ message: 'Authorization granted: Vault key issued to team member.' });
});

const getFeedbackAnalytics = asyncHandler(async (req, res) => {
  const isSuperAdmin = req.user.role === 'admin';
  const filter = isSuperAdmin ? { isDuplicate: { $ne: true } } : { department: req.user.department, isDuplicate: { $ne: true } };

  // 1. Department-wise stats (Bar Chart)
  const departmentStats = await Feedback.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { $ifNull: ['$department', 'Unknown'] },
        total: { $sum: 1 },
        complaints: {
          $sum: { $cond: [{ $eq: ['$category', 'complaint'] }, 1, 0] }
        }
      }
    },
    { $project: { name: '$_id', count: '$complaints', total: 1, _id: 0 } }
  ]);

  // 2. Category-wise stats (Pie Chart) - Javascript side string manipulation to avoid $substrCP crashing on empty strings
  const categoryStatsRaw = await Feedback.aggregate([
    { $match: filter },
    { 
      $group: { 
        _id: { 
          $cond: [ 
            { $in: ['$category', [null, '']] }, 
            'general', 
            '$category' 
          ] 
        }, 
        value: { $sum: 1 } 
      } 
    }
  ]);

  const categoryStats = categoryStatsRaw.map(stat => {
    const nameStr = String(stat._id);
    return {
      name: nameStr.charAt(0).toUpperCase() + nameStr.slice(1),
      value: stat.value
    };
  });

  // 3. Monthly Trends (Line/Area Chart) - last 6 months, securely backfilled to prevent chart gaps
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setDate(1); // Set to start of month to capture full 6-month window accurately
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const monthlyTrendsRaw = await Feedback.aggregate([
    { $match: { ...filter, createdAt: { $gte: sixMonthsAgo } } },
    {
      $group: {
        _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } },
        count: { $sum: 1 }
      }
    }
  ]);

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const formattedMonthlyTrends = [];
  
  // Guarantee exactly 6 contiguous months even if some have zero feedback
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const m = d.getMonth() + 1; // 1-12
    const y = d.getFullYear();
    
    const found = monthlyTrendsRaw.find(t => t._id.month === m && t._id.year === y);
    formattedMonthlyTrends.push({
      name: `${monthNames[m - 1]} ${y}`,
      count: found ? found.count : 0
    });
  }

  // 4. Common Complaints (Simple list)
  const commonComplaints = await Feedback.aggregate([
    { $match: { ...filter, category: 'complaint' } },
    { $group: { _id: { $ifNull: ['$title', 'Untitled'] }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
    { $project: { title: '$_id', count: 1, _id: 0 } }
  ]);

  res.json({
    departmentStats,
    categoryStats,
    monthlyTrends: formattedMonthlyTrends,
    commonComplaints
  });
});

module.exports = {
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
};
