const admin = require('firebase-admin');
const User = require('../models/User');
const Admin = require('../models/Admin');
const jwt = require('jsonwebtoken');

const { 
  fallbackNameFromEmail, 
  buildUniqueUsername, 
  generateDefaultAvatar 
} = require('../utils/userHelpers');

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];

    // 1. Try Firebase Authentication (for Users)
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const { uid, email, name, picture } = decodedToken;

      let user = await User.findOne({ firebaseUid: uid });

      if (!user) {
        // Before auto-creating a standard user, check if this email exists in the Admin collection
        const existingAdmin = await Admin.findOne({ email: (email || '').toLowerCase() });
        if (existingAdmin) {
          existingAdmin.isAdminCollection = true;
          req.user = existingAdmin;
          req.firebaseToken = decodedToken;
          return next();
        }

        const username = await buildUniqueUsername((email || '').split('@')[0]);
        const userName = name || fallbackNameFromEmail(email);
        user = await User.create({
          firebaseUid: uid,
          email: (email || '').toLowerCase(),
          name: userName,
          username,
          role: 'user',
          profilePhoto: picture || generateDefaultAvatar(userName),
        });
      }

      req.user = user;
      req.firebaseToken = decodedToken;
      return next();
    } catch (fbError) {
      // 2. Try Custom JWT (for Admins from 'admins' collection)
      try {
        const decoded = jwt.verify(idToken, process.env.JWT_SECRET);
        if (decoded.isAdminCollection) {
          const adminUser = await Admin.findById(decoded.id);
          if (adminUser) {
            adminUser.isAdminCollection = true;
            req.user = adminUser;
            return next();
          }
        }
      } catch (jwtError) {
        // Both failed
        throw new Error('Authentication failed');
      }
    }
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin' && req.user.isAdminCollection) {
    next();
  } else {
    return res.status(403).json({ message: 'Access denied. Admins only.' });
  }
};

const adminOrTeam = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'team') && req.user.isAdminCollection) {
    next();
  } else {
    return res.status(403).json({ message: 'Access denied. Privileged access only.' });
  }
};

module.exports = { protect, adminOnly, adminOrTeam };
