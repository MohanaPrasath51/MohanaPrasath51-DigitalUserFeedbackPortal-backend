const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const connectDB = require('./config/db');
const ensureAdminUser = require('./config/seedAdmin');
const cluster = require('cluster');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 5000;

// Multithreading Implementation Configuration
// Only use clustering in production or if explicitly enabled via USE_CLUSTER=true
const useCluster = process.env.NODE_ENV === 'production' || process.env.USE_CLUSTER === 'true';

if (useCluster && cluster.isMaster) {
  const numCPUs = os.cpus().length;
  console.log(`[Master] Spawning ${numCPUs} threads for the Feedback Portal...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[Master] Worker ${worker.process.pid} died. Respawning...`);
    cluster.fork();
  });
} else {
  // --- Start Workers or Single Process Logic ---

  // Define a cleaner prefix for logging (only if we're in a cluster worker)
  const logPrefix = cluster.isWorker ? `[Worker ${cluster.worker.id}] ` : '';

  const initializeApp = async () => {
    // 1. Load Firebase Credentials
    let firebaseCredential;
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

    function normalizePrivateKey(rawKey) {
      if (!rawKey) return rawKey;
      
      // 1. Remove literal quotes (single or double) if the entire string is wrapped
      let normalized = rawKey.trim();
      if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
          (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1);
      }

      // 2. Resolve newline escapes (\n or \\n)
      normalized = normalized.replace(/\\n/g, '\n').replace(/\\\\n/g, '\n');

      // 3. Ensure the header/footer have correct newlines
      if (!normalized.includes('\n') && normalized.includes('-----BEGIN PRIVATE KEY-----')) {
          normalized = normalized
              .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
              .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
      }

      return normalized.trim();
    }

    if (fs.existsSync(serviceAccountPath)) {
      console.log(`${logPrefix}Loading Firebase from serviceAccountKey.json`);
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        // Apply normalization to the key inside the JSON file too
        serviceAccount.password = normalizePrivateKey(serviceAccount.private_key); // Use normalized key
        
        firebaseCredential = admin.credential.cert({
            projectId: serviceAccount.project_id,
            clientEmail: serviceAccount.client_email,
            privateKey: normalizePrivateKey(serviceAccount.private_key),
        });
      } catch (err) {
        console.error(`${logPrefix}Error parsing serviceAccountKey.json:`, err.message);
        throw err;
      }
    } else {
      console.log(`${logPrefix}Loading Firebase from Environment Variables`);
      const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
      const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const rawFirebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY;

      const firebasePrivateKey = normalizePrivateKey(rawFirebasePrivateKey);

      if (!firebaseProjectId || !firebaseClientEmail || !firebasePrivateKey) {
        throw new Error('Missing Firebase Admin credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in backend/.env.');
      }

      firebaseCredential = admin.credential.cert({
        projectId: firebaseProjectId,
        clientEmail: firebaseClientEmail,
        privateKey: firebasePrivateKey,
      });
    }

    // 2. Initialize Firebase
    admin.initializeApp({
      credential: firebaseCredential,
    });

    // 3. Connect to Database (MongoDB)
    await connectDB();

    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : [];

    const corsOptions = {
      origin: function (origin, callback) {

        // allow requests with no origin (like mobile apps / Postman)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          console.log("Blocked by CORS:", origin);
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true
    };

    // 4. Initialize Express App & Socket.io
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { cors: corsOptions });

    app.set('io', io);

    io.on('connection', (socket) => {
      socket.on('join_feedback', (feedbackId) => socket.join(feedbackId));
      socket.on('leave_feedback', (feedbackId) => socket.leave(feedbackId));

      // Typing Indicators logic
      socket.on('typing', ({ feedbackId, userName, role }) => {
        socket.to(feedbackId).emit('user_typing', { userId: socket.id, userName, role });
      });

      socket.on('stop_typing', (feedbackId) => {
        socket.to(feedbackId).emit('user_stop_typing', { userId: socket.id });
      });
    });

    app.use(cors(corsOptions));
    app.use(express.json());

    // 5. Setup Routes
    app.use('/api/users', require('./routes/userRoutes'));
    app.use('/api/admin', require('./routes/adminRoutes'));
    app.use('/api/feedback', require('./routes/feedbackRoutes'));
    app.use('/api/notifications', require('./routes/notificationRoutes'));

    // 6. Health check & Error Handlers
    app.get('/', (req, res) => {
      res.json({ message: 'Feedback Portal API is running', worker: cluster.worker?.id });
    });

    app.use((req, res, next) => {
      res.status(404).json({ message: `Resource not found: ${req.originalUrl}` });
    });

    app.use((err, req, res, next) => {
      console.error(`${logPrefix}Error:`, err.stack);
      const status = err.status || 500;
      res.status(status).json({
        message: err.message || 'Internal Server Error',
        error: process.env.NODE_ENV === 'development' ? err : {}
      });
    });

    // 7. Seed Data and Start Server
    try {
      await ensureAdminUser(admin);
      console.log(`${logPrefix}Admin & Department seeding completed`);
    } catch (error) {
      console.error(`${logPrefix}Admin seed warning: ${error.message}`);
    }

    server.listen(PORT, () => {
      console.log(`${logPrefix}Server running on port ${PORT}`);
    });
  };

  // Start initialization
  initializeApp().catch((error) => {
    console.error(`${logPrefix}Startup error:`, error.message);
    if (error.message.includes('Invalid PEM formatted message')) {
      console.error(`${logPrefix}TIP: Your FIREBASE_PRIVATE_KEY is incorrectly formatted. Ensure it has \\n instead of literal newlines and no extra quotes.`);
    }
    process.exit(1);
  });
}
