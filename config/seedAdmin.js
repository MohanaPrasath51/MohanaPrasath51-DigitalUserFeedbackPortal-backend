const User = require('../models/User');
const Admin = require('../models/Admin');
const { hashPassword } = require('../utils/password');

const ADMIN_NAME = process.env.ADMIN_NAME || 'Main Admin';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@gmail.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345678';

// A hashed password always has the format "salt:hash" with a ":"
// If there's no colon, it's still plain-text and needs to be hashed.
function isAlreadyHashed(pw) {
  return typeof pw === 'string' && pw.includes(':');
}

async function ensureAdminUser(firebaseAdmin) {
  // ── Main Admin ──────────────────────────────────────────────────
  let adminRecord = await Admin.findOne({ email: ADMIN_EMAIL });

  if (!adminRecord) {
    await Admin.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      username: 'admin',
      password: hashPassword(ADMIN_PASSWORD),
      department: 'Admin Dashboard',
      role: 'admin',
    });
    console.log(`Seeded Main Admin: ${ADMIN_EMAIL}`);
  } else {
    let changed = false;

    // Fix plain-text password if still stored that way (one-time migration)
    if (!isAlreadyHashed(adminRecord.password)) {
      adminRecord.password = hashPassword(ADMIN_PASSWORD);
      changed = true;
      console.log('Migrated Main Admin password to hashed format');
    }
    // Ensure metadata is up to date
    if (adminRecord.name !== ADMIN_NAME)     { adminRecord.name = ADMIN_NAME;   changed = true; }
    if (adminRecord.username !== 'admin')    { adminRecord.username = 'admin';  changed = true; }
    if (adminRecord.role !== 'admin')        { adminRecord.role = 'admin';      changed = true; }
    if (changed) await adminRecord.save();
  }

  // ── Department Teams ─────────────────────────────────────────────
  const departments = [
    { name: 'NMC TEAM',         email: 'nmc@gmail.com',         username: 'nmc_team',         dept: 'NMC (Internet Issues)' },
    { name: 'Electrical Team',  email: 'electrical@gmail.com',  username: 'electrical_team',  dept: 'Electrical Team'       },
    { name: 'IT Support Team',  email: 'it@gmail.com',          username: 'it_team',          dept: 'IT Support'            },
    { name: 'Maintenance Team', email: 'maintenance@gmail.com', username: 'maintenance_team', dept: 'Campus Maintenance'    },
  ];

  for (const dept of departments) {
    let deptAdmin = await Admin.findOne({ email: dept.email });
    if (!deptAdmin) {
      await Admin.create({
        name: dept.name,
        email: dept.email,
        username: dept.username,
        password: hashPassword('password123'),
        department: dept.dept,
        role: 'team',
      });
      console.log(`Seeded department: ${dept.name}`);
    } else {
      let changed = false;
      // Fix plain-text password if still stored that way
      if (!isAlreadyHashed(deptAdmin.password)) {
        deptAdmin.password = hashPassword('password123');
        changed = true;
        console.log(`Migrated ${dept.name} password to hashed format`);
      }
      if (deptAdmin.username !== dept.username) { deptAdmin.username = dept.username; changed = true; }
      if (changed) await deptAdmin.save();
    }
  }

  // ── Cleanup: remove admin/dept emails from Users collection ──────
  await User.deleteMany({
    $or: [
      { role: 'admin' },
      { email: ADMIN_EMAIL },
      { email: { $in: departments.map(d => d.email) } },
    ],
  });

  return null;
}

module.exports = ensureAdminUser;
