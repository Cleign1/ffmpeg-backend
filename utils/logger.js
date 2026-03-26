/**
 * Custom Logger Utility for Server Console
 * Captures console logs and broadcasts them via Socket.IO
 */

let broadcastFunction = null;
const logBuffer = [];
const MAX_BUFFER_SIZE = 100;

// Store original console methods
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info
};

/**
 * Format a log entry with timestamp and level
 * @param {string} level - Log level (info, warn, error)
 * @param {Array} args - Console arguments
 * @returns {object} Formatted log entry
 */
function formatLogEntry(level, args) {
  const timestamp = new Date().toISOString();
  
  // Convert arguments to strings, handling objects and circular references
  let message = '';
  let data = null;
  
  try {
    message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular references
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    // If there's structured data, keep it separate
    if (args.length > 1 && typeof args[args.length - 1] === 'object') {
      data = args[args.length - 1];
    }
  } catch (e) {
    message = 'Error formatting log message';
  }
  
  return {
    timestamp,
    level,
    message,
    data
  };
}

/**
 * Add log entry to buffer and broadcast
 * @param {object} logEntry - Formatted log entry
 */
function addToBuffer(logEntry) {
  logBuffer.push(logEntry);
  
  // Maintain buffer size limit
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }
  
  // Broadcast if function is connected
  if (broadcastFunction) {
    broadcastFunction(logEntry);
  }
}

/**
 * Wrap console methods to capture logs
 */
function wrapConsole() {
  console.log = function(...args) {
    originalConsole.log.apply(console, args);
    const logEntry = formatLogEntry('info', args);
    addToBuffer(logEntry);
  };

  console.info = function(...args) {
    originalConsole.info.apply(console, args);
    const logEntry = formatLogEntry('info', args);
    addToBuffer(logEntry);
  };

  console.warn = function(...args) {
    originalConsole.warn.apply(console, args);
    const logEntry = formatLogEntry('warn', args);
    addToBuffer(logEntry);
  };

  console.error = function(...args) {
    originalConsole.error.apply(console, args);
    const logEntry = formatLogEntry('error', args);
    addToBuffer(logEntry);
  };
}

/**
 * Initialize the logger with a broadcast function
 * @param {Function} broadcastFn - Function to call when new logs arrive
 */
export function initializeLogger(broadcastFn) {
  broadcastFunction = broadcastFn;
  wrapConsole();
  console.log('[Logger] 📝 Custom logger initialized');
}

/**
 * Get the current log buffer
 * @returns {Array} Array of log entries
 */
export function getLogBuffer() {
  return [...logBuffer];
}

/**
 * Clear the log buffer
 */
export function clearLogBuffer() {
  logBuffer.length = 0;
}
