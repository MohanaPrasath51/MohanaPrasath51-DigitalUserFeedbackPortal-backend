const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGO_URI;

    if (!mongoURI) {
      console.error('❌ Error: MONGO_URI is not defined in environment variables.');
      process.exit(1);
    }

    const options = {
      // Add any specific mongoose options here if needed in the future
    };

    const conn = await mongoose.connect(mongoURI, options);
    
    console.log(`\x1b[32m%s\x1b[0m`, `✓ MongoDB Connected: ${conn.connection.host}`);
    
    // Additional event listeners for better observability
    mongoose.connection.on('error', (err) => {
      console.error(`MongoDB persistent error: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB connection lost. Attempting to reconnect...');
    });

    return conn;
  } catch (error) {
    console.error(`\x1b[31m%s\x1b[0m`, `✗ MongoDB connection error: ${error.message}`);
    // Optional: Implement a retry logic instead of exiting
    process.exit(1);
  }
};

module.exports = connectDB;
