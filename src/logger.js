import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, 'logs');

// Create logs directory if it doesn't exist
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Generate log filename with date
function getLogFilePath() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
  return path.join(LOG_DIR, `bot-${dateStr}-${timeStr}.log`);
}

const logFilePath = getLogFilePath();
let logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

/**
 * Format log message with timestamp
 */
function formatLogMessage(message) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] ${message}`;
}

/**
 * Write to log file
 */
function writeToLog(message) {
  try {
    logStream.write(formatLogMessage(message) + '\n');
  } catch (err) {
    console.error('Error writing to log file:', err);
  }
}

/**
 * Override console methods to log to file
 */
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = function (...args) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  originalLog.apply(console, args);
  writeToLog(message);
};

console.error = function (...args) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  originalError.apply(console, args);
  writeToLog(`ERROR: ${message}`);
};

console.warn = function (...args) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  originalWarn.apply(console, args);
  writeToLog(`WARNING: ${message}`);
};

/**
 * Close log file stream gracefully
 */
export function closeLogFile() {
  return new Promise((resolve) => {
    if (logStream) {
      logStream.end(() => {
        console.log(`\n📁 Log file saved: ${logFilePath}`);
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Get the current log file path
 */
export function getLogFile() {
  return logFilePath;
}

export default {
  closeLogFile,
  getLogFile,
};
