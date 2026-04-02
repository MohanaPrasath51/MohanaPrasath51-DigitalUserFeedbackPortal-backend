const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  username: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    sparse: true,
    default: null,
  },
  role: {
    type: String,
    default: 'user',
  },
  firebaseUid: {
    type: String,
    required: [true, 'Firebase UID is required'],
    unique: true,
  },
  passwordHash: {
    type: String,
    default: null,
  },
  profilePhoto: {
    type: String,
    default: '',
  },
  theme: { type: String, enum: ["light", "dark"], default: "dark" },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('User', userSchema);
