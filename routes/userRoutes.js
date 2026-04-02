const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { hashPassword, verifyPassword } = require('../utils/password');

const { normalizeUsername, buildUniqueUsername, fallbackNameFromEmail, generateDefaultAvatar } = require('../utils/userHelpers');

// POST /api/users/register - Create or sync user profile in MongoDB
router.post('/register', async (req, res) => {
  try {
    const { name, email, firebaseUid, password, username } = req.body;

    if (!name || !email || !firebaseUid) {
      return res.status(400).json({ message: 'name, email and firebaseUid are required' });
    }

    if (password !== undefined && (typeof password !== 'string' || password.length < 6)) {
      return res.status(400).json({ message: 'password must be at least 6 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedName = name.trim();
    const requestedUsername = normalizeUsername(username);
    const passwordHash = password ? hashPassword(password) : null;

    let user = await User.findOne({
      $or: [{ email: normalizedEmail }, { firebaseUid }],
    });

    const effectiveUsername = await buildUniqueUsername(
      requestedUsername || normalizedEmail.split('@')[0],
      user?._id
    );

    if (user) {
      user.name = trimmedName;
      user.email = normalizedEmail;
      user.firebaseUid = firebaseUid;
      user.username = effectiveUsername;
      if (passwordHash) user.passwordHash = passwordHash;
      await user.save();
    } else {
      user = await User.create({
        name: trimmedName,
        email: normalizedEmail,
        username: effectiveUsername,
        role: 'user',
        firebaseUid,
        passwordHash,
        profilePhoto: generateDefaultAvatar(trimmedName),
      });
    }

    res.status(200).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      firebaseUid: user.firebaseUid,
      profilePhoto: user.profilePhoto || '',
      theme: user.theme || 'dark',
      hasPassword: Boolean(user.passwordHash),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/users/login - Email/Username + password login against MongoDB password hash
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ message: 'identifier and password are required' });
    }

    const normalizedIdentifier = identifier.toLowerCase().trim();
    const user = await User.findOne({
      $or: [{ email: normalizedIdentifier }, { username: normalizedIdentifier }],
    });

    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    let shouldSave = false;
    if (!user.name || user.name.trim().toLowerCase() === 'user') {
      user.name = fallbackNameFromEmail(user.email);
      shouldSave = true;
    }
    if (!user.username && user.email) {
      user.username = await buildUniqueUsername(user.email.split('@')[0], user._id);
      shouldSave = true;
    }
    if (!user.profilePhoto) {
      user.profilePhoto = generateDefaultAvatar(user.name);
      shouldSave = true;
    }
    if (shouldSave) {
      await user.save();
    }

    const token = await admin.auth().createCustomToken(user.firebaseUid);

    res.json({
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        role: user.role,
        firebaseUid: user.firebaseUid,
        profilePhoto: user.profilePhoto || '',
        theme: user.theme || 'dark',
        hasPassword: Boolean(user.passwordHash),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/users/me - Get current user profile
router.get('/me', protect, (req, res) => {
  res.json({
    _id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    username: req.user.username || req.user.name,
    role: req.user.role,
    department: req.user.department || '',
    firebaseUid: req.user.firebaseUid,
    profilePhoto: req.user.profilePhoto || '',
    theme: req.user.theme || 'dark',
    hasPassword: Boolean(req.user.passwordHash),
    createdAt: req.user.createdAt,
  });
});

// PUT /api/users/profile - Update username, password and profile photo
router.put('/profile', protect, async (req, res) => {
  try {
    const { username, password, profilePhoto, email } = req.body;
    const user = req.user;

    if (email !== undefined) {
      const normalizedEmail = email.toLowerCase().trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(normalizedEmail)) {
        return res.status(400).json({ message: 'Invalid email format' });
      }

      if (normalizedEmail !== user.email) {
        // Check both collections (Users and Admins) for uniqueness
        const [existingUser, existingAdmin] = await Promise.all([
          User.findOne({ email: normalizedEmail }),
          Admin.findOne({ email: normalizedEmail })
        ]);

        if (existingUser || existingAdmin) {
          return res.status(400).json({ message: 'Email already in use' });
        }
        user.email = normalizedEmail;
      }
    }

    if (username !== undefined) {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername) {
        return res.status(400).json({ message: 'username is invalid' });
      }

      if (normalizedUsername !== user.username) {
        // Check current model type to query correct collection for existing
        const Model = user.isAdminCollection ? Admin : User;
        const [existingUser, existingAdmin] = await Promise.all([
          User.findOne({ username: normalizedUsername }),
          Admin.findOne({ username: normalizedUsername })
        ]);

        if (existingUser || existingAdmin) {
          return res.status(400).json({ message: 'username already in use' });
        }
        user.username = normalizedUsername;
      }
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ message: 'password must be at least 6 characters' });
      }
      user.passwordHash = hashPassword(password);
      // For Admin model, the field is named 'password' not 'passwordHash'
      if (user.isAdminCollection) {
        user.password = user.passwordHash;
      }
    }

    if (profilePhoto !== undefined) {
      if (profilePhoto !== null && typeof profilePhoto !== 'string') {
        return res.status(400).json({ message: 'profilePhoto must be a string' });
      }
      user.profilePhoto = profilePhoto || '';
    }

    await user.save();

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      firebaseUid: user.firebaseUid,
      profilePhoto: user.profilePhoto || '',
      hasPassword: Boolean(user.passwordHash),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PUT /api/users/theme - Update user theme preference
router.put('/theme', protect, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ message: 'Invalid theme. Must be light or dark.' });
    }

    const user = req.user;
    user.theme = theme;
    await user.save();

    res.json({ theme: user.theme });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
