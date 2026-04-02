const express = require('express');
const router = express.Router();
const Admin = require('../models/Admin');
const jwt = require('jsonwebtoken');

const { protect, adminOnly } = require('../middleware/authMiddleware');
const { verifyPassword } = require('../utils/password');

// GET /api/admin/ - Get all admin members
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const admins = await Admin.find({}).select('-password');
    res.json(admins);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/admin/login - Login for admins and department teams (email or username)
router.post('/login', async (req, res) => {
  try {
    const { email, identifier: rawIdentifier, password } = req.body;

    // Accept either 'identifier' (new) or legacy 'email' (old) field
    const identifier = (rawIdentifier || email || '').toLowerCase().trim();

    if (!identifier || !password) {
      return res.status(400).json({ message: 'identifier and password are required' });
    }

    // Search by email OR username in the Admins collection
    const adminRecord = await Admin.findOne({
      $or: [{ email: identifier }, { username: identifier }],
    });

    if (!adminRecord || !verifyPassword(password, adminRecord.password)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate a JWT for the admin
    const token = jwt.sign(
      {
        id: adminRecord._id,
        role: adminRecord.role,
        isAdminCollection: true,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      token,
      user: {
        _id: adminRecord._id,
        name: adminRecord.name,
        email: adminRecord.email,
        username: adminRecord.username,
        department: adminRecord.department,
        role: adminRecord.role,
        theme: adminRecord.theme || 'dark',
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


module.exports = router;
