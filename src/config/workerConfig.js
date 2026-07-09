/**
 * Worker Configuration
 * Centralized configuration for optimal scraping performance
 */

export const WORKER_CONFIG = {
  // Worker Concurrency
  MAIN_WORKER_CONCURRENCY: parseInt(process.env.WORKER_CONCURRENCY || "10"),
  ENRICHMENT_CONCURRENCY: parseInt(process.env.LEAD_ENRICHMENT_CONCURRENCY || "8"),
  SCRAPE_CONCURRENCY: parseInt(process.env.SCRAPE_CONCURRENCY || "15"),

  // Browser Pool
  BROWSER_POOL: {
    MIN_INSTANCES: parseInt(process.env.MIN_BROWSER_INSTANCES || "2"),
    MAX_INSTANCES: parseInt(process.env.MAX_BROWSER_INSTANCES || "5"),
    MAX_PAGES_PER_BROWSER: parseInt(process.env.MAX_PAGES_PER_BROWSER || "10"),
    PAGE_TIMEOUT_MS: parseInt(process.env.PAGE_TIMEOUT_MS || "30000"),
    BROWSER_IDLE_TIMEOUT_MS: parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS || "300000"), // 5 min
    WARMUP_ON_START: process.env.BROWSER_WARMUP === "true",
    HEADLESS: process.env.BROWSER_HEADLESS !== "false",
    ARGS: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  },

  // Rate Limiting (requests per minute per source)
  RATE_LIMITS: {
    'google_search': parseInt(process.env.RATE_GOOGLE_SEARCH || "100"),
    'google_maps': parseInt(process.env.RATE_GOOGLE_MAPS || "60"),
    'linkedin': parseInt(process.env.RATE_LINKEDIN || "30"),
    'instagram': parseInt(process.env.RATE_INSTAGRAM || "40"),
    'facebook': parseInt(process.env.RATE_FACEBOOK || "50"),
    'youtube': parseInt(process.env.RATE_YOUTUBE || "60"),
    'tripadvisor': parseInt(process.env.RATE_TRIPADVISOR || "30"),
    'amazon': parseInt(process.env.RATE_AMAZON || "80"),
    'website': parseInt(process.env.RATE_WEBSITE || "120"),
    'default': parseInt(process.env.RATE_DEFAULT || "60"),
  },

  // Retry Strategy
  RETRY: {
    MAX_ATTEMPTS: parseInt(process.env.MAX_JOB_ATTEMPTS || "3"),
    BACKOFF_TYPE: process.env.BACKOFF_TYPE || "exponential",
    INITIAL_DELAY_MS: parseInt(process.env.RETRY_INITIAL_DELAY || "5000"),
    MAX_DELAY_MS: parseInt(process.env.RETRY_MAX_DELAY || "60000"),
  },

  // Proxy Configuration
  PROXY: {
    ENABLED: process.env.USE_PROXY === "true",
    ROTATION_STRATEGY: process.env.PROXY_STRATEGY || "round-robin", // round-robin, least-used, success-rate
    MIN_SUCCESS_RATE: parseFloat(process.env.PROXY_MIN_SUCCESS_RATE || "0.7"),
    HEALTH_CHECK_INTERVAL_MS: parseInt(process.env.PROXY_HEALTH_CHECK_INTERVAL || "300000"), // 5 min
    MAX_CONSECUTIVE_FAILS: parseInt(process.env.PROXY_MAX_FAILS || "5"),
    COOLDOWN_PERIOD_MS: parseInt(process.env.PROXY_COOLDOWN_MS || "600000"), // 10 min
  },

  // Batch Processing
  BATCH: {
    ENABLED: process.env.BATCH_ENABLED === "true",
    DEFAULT_SIZE: parseInt(process.env.BATCH_SIZE || "10"),
    MAX_SIZE: parseInt(process.env.BATCH_MAX_SIZE || "50"),
    MIN_SIZE: parseInt(process.env.BATCH_MIN_SIZE || "5"),
    TIMEOUT_MS: parseInt(process.env.BATCH_TIMEOUT_MS || "300000"), // 5 min
    PARALLEL_WITHIN_BATCH: parseInt(process.env.BATCH_PARALLEL || "3"),
  },

  // Memory Management
  MEMORY: {
    MAX_HEAP_MB: parseInt(process.env.MAX_HEAP_MB || "4096"),
    GC_THRESHOLD_MB: parseInt(process.env.GC_THRESHOLD_MB || "3072"),
    AUTO_RESTART_ON_MEMORY_LEAK: process.env.AUTO_RESTART_MEMORY === "true",
  },

  // Circuit Breaker
  CIRCUIT_BREAKER: {
    ENABLED: process.env.CIRCUIT_BREAKER_ENABLED !== "false",
    FAILURE_THRESHOLD: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD || "5"),
    RESET_TIMEOUT_MS: parseInt(process.env.CIRCUIT_RESET_TIMEOUT || "60000"), // 1 min
    HALF_OPEN_MAX_CALLS: parseInt(process.env.CIRCUIT_HALF_OPEN_CALLS || "3"),
  },

  // Performance Monitoring
  MONITORING: {
    ENABLED: process.env.MONITORING_ENABLED !== "false",
    METRICS_INTERVAL_MS: parseInt(process.env.METRICS_INTERVAL || "60000"), // 1 min
    LOG_SLOW_JOBS_MS: parseInt(process.env.LOG_SLOW_JOBS || "30000"), // 30s
    TRACK_MEMORY: process.env.TRACK_MEMORY !== "false",
    TRACK_SUCCESS_RATE: process.env.TRACK_SUCCESS_RATE !== "false",
  },

  // Job Priorities
  JOB_PRIORITIES: {
    'realtime': 1, // Highest priority (user-initiated)
    'scheduled': 5, // Medium priority (cron jobs)
    'bulk': 10,     // Lower priority (bulk imports)
    'enrichment': 7, // Medium-high (automatic enrichments)
    'retry': 8,     // Medium-low (failed job retries)
  },

  // Timeouts
  TIMEOUTS: {
    JOB_STALLED_MS: parseInt(process.env.JOB_STALLED_TIMEOUT || "30000"),
    JOB_LOCK_MS: parseInt(process.env.JOB_LOCK_DURATION || "30000"),
    SCRAPE_TIMEOUT_MS: parseInt(process.env.SCRAPE_TIMEOUT || "60000"),
    ENRICHMENT_TIMEOUT_MS: parseInt(process.env.ENRICHMENT_TIMEOUT || "45000"),
    API_REQUEST_TIMEOUT_MS: parseInt(process.env.API_TIMEOUT || "15000"),
  },

  // Cache Settings
  CACHE: {
    ENABLED: process.env.CACHE_ENABLED !== "false",
    TTL_SECONDS: parseInt(process.env.CACHE_TTL || "86400"), // 24 hours
    DEDUP_TTL_SECONDS: parseInt(process.env.DEDUP_TTL || "300"), // 5 min
    MAX_SIZE_MB: parseInt(process.env.CACHE_MAX_SIZE || "512"),
  },

  // Redis
  REDIS: {
    URL: process.env.REDIS_URL || "redis://localhost:6379",
    MAX_RETRIES: parseInt(process.env.REDIS_MAX_RETRIES || "5"),
    RETRY_DELAY_MS: parseInt(process.env.REDIS_RETRY_DELAY || "500"),
    CONNECT_TIMEOUT_MS: parseInt(process.env.REDIS_CONNECT_TIMEOUT || "10000"),
  },

  // BullMQ Queue Options
  QUEUE_OPTIONS: {
    defaultJobOptions: {
      attempts: parseInt(process.env.MAX_JOB_ATTEMPTS || "3"),
      backoff: {
        type: process.env.BACKOFF_TYPE || "exponential",
        delay: parseInt(process.env.RETRY_INITIAL_DELAY || "5000"),
      },
      removeOnComplete: {
        age: 86400, // 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 604800, // 7 days
        count: 5000,
      },
    },
    limiter: {
      max: parseInt(process.env.QUEUE_MAX_JOBS || "100"),
      duration: parseInt(process.env.QUEUE_DURATION_MS || "60000"), // 1 min
    },
  },
};

/**
 * Get rate limit for a specific source
 */
export function getRateLimit(source) {
  return WORKER_CONFIG.RATE_LIMITS[source] || WORKER_CONFIG.RATE_LIMITS.default;
}

/**
 * Get job priority
 */
export function getJobPriority(type) {
  return WORKER_CONFIG.JOB_PRIORITIES[type] || WORKER_CONFIG.JOB_PRIORITIES.bulk;
}

/**
 * Calculate delay based on risk level
 */
export function calculateDelay(riskLevel) {
  const delays = {
    low: 1000,      // 1s
    medium: 3000,   // 3s
    high: 5000,     // 5s
    critical: 10000 // 10s
  };
  return delays[riskLevel] || delays.medium;
}

/**
 * Validate worker configuration
 */
export function validateConfig() {
  const errors = [];

  if (WORKER_CONFIG.MAIN_WORKER_CONCURRENCY < 1) {
    errors.push("MAIN_WORKER_CONCURRENCY must be >= 1");
  }

  if (WORKER_CONFIG.BROWSER_POOL.MAX_INSTANCES < WORKER_CONFIG.BROWSER_POOL.MIN_INSTANCES) {
    errors.push("MAX_BROWSER_INSTANCES must be >= MIN_BROWSER_INSTANCES");
  }

  if (WORKER_CONFIG.MEMORY.GC_THRESHOLD_MB >= WORKER_CONFIG.MEMORY.MAX_HEAP_MB) {
    errors.push("GC_THRESHOLD_MB must be < MAX_HEAP_MB");
  }

  if (errors.length > 0) {
    console.error("[Config] Validation errors:", errors);
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
  }

  console.log("[Config] ✅ Configuration validated successfully");
  return true;
}

/**
 * Log current configuration
 */
export function logConfig() {
  console.log("\n╔════════════════════════════════════════════════╗");
  console.log("║      CompX Worker Configuration                ║");
  console.log("╠════════════════════════════════════════════════╣");
  console.log(`║ Main Worker Concurrency: ${WORKER_CONFIG.MAIN_WORKER_CONCURRENCY.toString().padEnd(23)}║`);
  console.log(`║ Enrichment Concurrency:  ${WORKER_CONFIG.ENRICHMENT_CONCURRENCY.toString().padEnd(23)}║`);
  console.log(`║ Browser Instances:       ${WORKER_CONFIG.BROWSER_POOL.MIN_INSTANCES}-${WORKER_CONFIG.BROWSER_POOL.MAX_INSTANCES}${' '.repeat(21)}║`);
  console.log(`║ Batch Processing:        ${(WORKER_CONFIG.BATCH.ENABLED ? 'Enabled' : 'Disabled').padEnd(23)}║`);
  console.log(`║ Proxy Rotation:          ${(WORKER_CONFIG.PROXY.ENABLED ? 'Enabled' : 'Disabled').padEnd(23)}║`);
  console.log(`║ Circuit Breaker:         ${(WORKER_CONFIG.CIRCUIT_BREAKER.ENABLED ? 'Enabled' : 'Disabled').padEnd(23)}║`);
  console.log(`║ Memory Limit:            ${WORKER_CONFIG.MEMORY.MAX_HEAP_MB}MB${' '.repeat(18)}║`);
  console.log("╚════════════════════════════════════════════════╝\n");
}

// Export default
export default WORKER_CONFIG;
