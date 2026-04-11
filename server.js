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
    // 1. Loading Firebase Credentials
    let firebaseCredential;
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

    // Robust normalization for Private Keys (Fixes Render/Vercel PEM errors)
    function normalizePrivateKey(rawKey) {
      if (!rawKey) return rawKey;
      let normalized = rawKey.trim();
      
      // Strip accidental wrapping quotes
      if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1);
      }
      
      const header = '-----BEGIN PRIVATE KEY-----';
      const footer = '-----END PRIVATE KEY-----';
      
      if (normalized.includes(header) && normalized.includes(footer)) {
        // Extract the part between header and footer
        const parts = normalized.split(header);
        const subParts = parts[1].split(footer);
        // Aggressively strip everything except valid base64 characters
        const body = subParts[0].replace(/[^a-zA-Z0-9+/=]/g, '');
        
        // Wrap body at 64 characters (standard PEM format)
        const wrappedBody = body.match(/.{1,64}/g).join('\n');
        return `${header}\n${wrappedBody}\n${footer}\n`;
      }
      
      // Fallback: Replace escaped newlines with real ones
      return normalized.replace(/\\+n/g, '\n').trim();
    }

    // PRIORITY 1: Base64 Encoded Service Account (Single String - Best for Production)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      console.log(`${logPrefix}Loading Firebase from FIREBASE_SERVICE_ACCOUNT_BASE64`);
      try {
        let base64Str = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64.trim();
        // Strip accidental quotes if present
        if ((base64Str.startsWith('"') && base64Str.endsWith('"')) ||
          (base64Str.startsWith("'") && base64Str.endsWith("'"))) {
          base64Str = base64Str.slice(1, -1);
        }
        const decoded = Buffer.from(base64Str, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(decoded);
        serviceAccount.private_key = normalizePrivateKey(serviceAccount.private_key);
        firebaseCredential = admin.credential.cert(serviceAccount);
      } catch (err) {
        console.error(`${logPrefix}Error decoding FIREBASE_SERVICE_ACCOUNT_BASE64:`, err.message);
        throw err;
      }
    }
    // PRIORITY 2: Local JSON File
    else if (fs.existsSync(serviceAccountPath)) {
      console.log(`${logPrefix}Loading Firebase from serviceAccountKey.json`);
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        firebaseCredential = admin.credential.cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: normalizePrivateKey(serviceAccount.private_key),
        });
      } catch (err) {
        console.error(`${logPrefix}Error parsing serviceAccountKey.json:`, err.message);
        throw err;
      }
    }
    // PRIORITY 3: Individual Environment Variables
    else {
      console.log(`${logPrefix}Loading Firebase from Individual Environment Variables`);
      const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
      const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const rawFirebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY;

      const firebasePrivateKey = normalizePrivateKey(rawFirebasePrivateKey);

      if (!firebaseProjectId || !firebaseClientEmail || !firebasePrivateKey) {
        throw new Error('Missing Firebase Admin identity. Set FIREBASE_SERVICE_ACCOUNT_BASE64 or provide individual variables.');
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
    
    // SECURITY & PERFORMANCE MIDDLEWARE
    const helmet = require('helmet');
    const compression = require('compression');
    
    app.use(helmet({
      contentSecurityPolicy: false, // Disable for APIs normally to allow easier client connection
      crossOriginResourcePolicy: { policy: "cross-origin" }
    }));
    app.use(compression()); // Compress all responses for better performance
    
    const io = new Server(server, { 
      cors: corsOptions,
      pingTimeout: 60000, // Handle slower production networks
    });

    app.set('io', io);

    io.on('connection', (socket) => {
      // socket logic remains same...
      socket.on('join_feedback', (feedbackId) => socket.join(feedbackId));
      socket.on('leave_feedback', (feedbackId) => socket.leave(feedbackId));

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
      res.json({ 
        status: 'UP',
        message: 'Feedback Portal API is healthy', 
        worker: cluster.worker?.id,
        timestamp: new Date()
      });
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

    // Graceful Shutdown Logic (For Production)
    process.on('SIGTERM', () => {
      console.info(`${logPrefix}SIGTERM received. Shutting down gracefully...`);
      server.close(() => {
        console.log(`${logPrefix}Process terminated.`);
        require('mongoose').connection.close();
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      console.info(`${logPrefix}SIGINT received. Shutting down gracefully...`);
      server.close(() => {
        console.log(`${logPrefix}Process terminated.`);
        require('mongoose').connection.close();
        process.exit(0);
      });
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
