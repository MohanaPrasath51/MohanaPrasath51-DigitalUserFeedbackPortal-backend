const User = require('../models/User');

function normalizeUsername(username) {
  if (!username) return null;
  return username
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '');
}

function fallbackNameFromEmail(email) {
  if (!email) return 'User';
  const [localPart] = email.split('@');
  if (!localPart) return 'User';
  return localPart
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

async function buildUniqueUsername(baseUsername, excludeUserId = null) {
  const base = normalizeUsername(baseUsername) || `user${Date.now()}`;
  let candidate = base;
  let suffix = 1;

  while (true) {
    const query = { username: candidate };
    if (excludeUserId) query._id = { $ne: excludeUserId };

    const existing = await User.findOne(query);
    if (!existing) return candidate;

    suffix += 1;
    candidate = `${base}${suffix}`;
  }
}

function generateDefaultAvatar(name) {
  const seed = encodeURIComponent(name || 'User');
  return `https://ui-avatars.com/api/?name=${seed}&background=random&color=fff&size=128`;
}

module.exports = {
  normalizeUsername,
  fallbackNameFromEmail,
  buildUniqueUsername,
  generateDefaultAvatar,
};
