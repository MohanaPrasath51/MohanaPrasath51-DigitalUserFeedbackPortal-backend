const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    trim: true,
  },
  category: {
    type: String,
    enum: ['suggestion', 'complaint', 'bug', 'general'],
    default: 'general',
  },
  department: {
    type: String,
    required: [true, 'Department is required'],
    trim: true,
  },
  isDuplicate: {
    type: Boolean,
    default: false,
  },
  duplicateOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Feedback',
    default: null,
  },
  duplicateCount: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'in-review', 'resolved', 'closed'],
    default: 'pending',
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium',
  },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  adminResponse: {
    type: String,
    default: '',
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null,
  },
  chatAccessRequests: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    }
  ],
  permittedTeamMembers: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    }
  ],
  messages: [
    {
      senderId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'messages.senderType'
      },
      senderType: {
        type: String,
        enum: ['User', 'Admin'],
        required: true,
      },
      content: {
        type: String,
        required: true,
      },
      createdAt: {
        type: Date,
        default: Date.now,
      },
      isReadByAdmin: {
        type: Boolean,
        default: false,
      },
      isReadByUser: {
        type: Boolean,
        default: false,
      },
    },
  ],
  attachments: [
    {
      url: { type: String, required: true },
      filename: { type: String },
      contentType: { type: String },
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  resolvedAt: {
    type: Date,
    default: null,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Performance Optimization: Strategic Indexing
feedbackSchema.index({ department: 1, status: 1 });
feedbackSchema.index({ isDuplicate: 1, createdAt: -1 });
feedbackSchema.index({ submittedBy: 1, createdAt: -1 });
feedbackSchema.index({ duplicateOf: 1 });
feedbackSchema.index({ createdAt: -1 });

feedbackSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Feedback', feedbackSchema);
