/**
 * Smart Proxy Rotator
 * Intelligent proxy rotation with health monitoring and success-rate tracking
 */

import { WORKER_CONFIG } from '../config/workerConfig.js';

class SmartProxyRotator {
  constructor() {
    this.proxies = new Map(); // proxyID => { url, stats, lastUsed, status }
    this.sourceProxies = new Map(); // source => Set of proxyIDs
    this.currentIndex = 0;
    this.healthCheckInterval = null;
  }

  /**
   * Initialize with proxy list
   */
  initialize(proxyList = []) {
    console.log('[ProxyRotator] Initializing with', proxyList.length, 'proxies');

    for (const proxy of proxyList) {
      const proxyID = proxy.id || `proxy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      this.proxies.set(proxyID, {
        id: proxyID,
        url: proxy.url,
        country: proxy.country || 'US',
        type: proxy.type || 'datacenter', // datacenter, residential
        stats: {
          total: 0,
          success: 0,
          failed: 0,
          avgResponseTime: 0,
          consecutiveFails: 0,
        },
        lastUsed: 0,
        status: 'active', // active, cooldown, disabled
        cooldownUntil: 0,
      });

      // Map proxies to sources if specified
      if (proxy.sources) {
        for (const source of proxy.sources) {
          if (!this.sourceProxies.has(source)) {
            this.sourceProxies.set(source, new Set());
          }
          this.sourceProxies.get(source).add(proxyID);
        }
      }
    }

    // Start health check
    if (WORKER_CONFIG.PROXY.ENABLED && this.proxies.size > 0) {
      this.startHealthCheck();
    }

    console.log('[ProxyRotator] ✅ Initialized with', this.proxies.size, 'proxies');
  }

  /**
   * Get best proxy for a source
   */
  async getBest(options = {}) {
    if (!WORKER_CONFIG.PROXY.ENABLED || this.proxies.size === 0) {
      return null;
    }

    const { source, country, type } = options;

    // Get candidate proxies
    let candidates = Array.from(this.proxies.values());

    // Filter by source if specified
    if (source && this.sourceProxies.has(source)) {
      const sourceProxyIDs = this.sourceProxies.get(source);
      candidates = candidates.filter(p => sourceProxyIDs.has(p.id));
    }

    // Filter by country if specified
    if (country) {
      candidates = candidates.filter(p => p.country === country);
    }

    // Filter by type if specified
    if (type) {
      candidates = candidates.filter(p => p.type === type);
    }

    // Filter out proxies in cooldown or disabled
    const now = Date.now();
    candidates = candidates.filter(p => {
      if (p.status === 'disabled') return false;
      if (p.status === 'cooldown' && p.cooldownUntil > now) return false;
      if (p.status === 'cooldown' && p.cooldownUntil <= now) {
        p.status = 'active'; // Restore from cooldown
        p.stats.consecutiveFails = 0;
      }
      return true;
    });

    if (candidates.length === 0) {
      console.warn('[ProxyRotator] No available proxies for:', options);
      return null;
    }

    // Select proxy based on strategy
    const strategy = WORKER_CONFIG.PROXY.ROTATION_STRATEGY;
    let selected = null;

    switch (strategy) {
      case 'round-robin':
        selected = this.selectRoundRobin(candidates);
        break;
      case 'least-used':
        selected = this.selectLeastUsed(candidates);
        break;
      case 'success-rate':
        selected = this.selectBySuccessRate(candidates);
        break;
      case 'response-time':
        selected = this.selectByResponseTime(candidates);
        break;
      default:
        selected = this.selectRoundRobin(candidates);
    }

    if (selected) {
      selected.lastUsed = Date.now();
      selected.stats.total++;
    }

    return selected;
  }

  /**
   * Round-robin selection
   */
  selectRoundRobin(candidates) {
    const index = this.currentIndex % candidates.length;
    this.currentIndex++;
    return candidates[index];
  }

  /**
   * Least-used selection
   */
  selectLeastUsed(candidates) {
    return candidates.reduce((min, p) => 
      p.stats.total < min.stats.total ? p : min
    );
  }

  /**
   * Select by success rate
   */
  selectBySuccessRate(candidates) {
    // Calculate success rates
    const withRate = candidates.map(p => ({
      proxy: p,
      rate: p.stats.total > 0 ? p.stats.success / p.stats.total : 1,
    }));

    // Sort by success rate (descending)
    withRate.sort((a, b) => b.rate - a.rate);

    // Top 30% candidates
    const topCandidates = withRate.slice(0, Math.max(1, Math.ceil(withRate.length * 0.3)));

    // Random selection from top candidates
    return topCandidates[Math.floor(Math.random() * topCandidates.length)].proxy;
  }

  /**
   * Select by response time
   */
  selectByResponseTime(candidates) {
    // Filter out proxies with no data
    const withResponseTime = candidates.filter(p => p.stats.avgResponseTime > 0);

    if (withResponseTime.length === 0) {
      return this.selectRoundRobin(candidates);
    }

    // Sort by response time (ascending)
    withResponseTime.sort((a, b) => a.stats.avgResponseTime - b.stats.avgResponseTime);

    // Return fastest proxy
    return withResponseTime[0];
  }

  /**
   * Mark proxy as successful
   */
  async markSuccess(proxyID, responseTimeMs) {
    const proxy = this.proxies.get(proxyID);
    if (!proxy) return;

    proxy.stats.success++;
    proxy.stats.consecutiveFails = 0;

    // Update average response time
    if (responseTimeMs) {
      const total = proxy.stats.total;
      proxy.stats.avgResponseTime = 
        (proxy.stats.avgResponseTime * (total - 1) + responseTimeMs) / total;
    }

    // Remove from cooldown if it was in cooldown
    if (proxy.status === 'cooldown') {
      proxy.status = 'active';
      console.log(`[ProxyRotator] Proxy ${proxyID} restored from cooldown`);
    }
  }

  /**
   * Mark proxy as failed
   */
  async markFail(proxyID, error = null) {
    const proxy = this.proxies.get(proxyID);
    if (!proxy) return;

    proxy.stats.failed++;
    proxy.stats.consecutiveFails++;

    console.warn(`[ProxyRotator] Proxy ${proxyID} failed (consecutive: ${proxy.stats.consecutiveFails})`);

    // Put in cooldown if too many consecutive failures
    if (proxy.stats.consecutiveFails >= WORKER_CONFIG.PROXY.MAX_CONSECUTIVE_FAILS) {
      proxy.status = 'cooldown';
      proxy.cooldownUntil = Date.now() + WORKER_CONFIG.PROXY.COOLDOWN_PERIOD_MS;
      console.warn(`[ProxyRotator] Proxy ${proxyID} in cooldown for ${WORKER_CONFIG.PROXY.COOLDOWN_PERIOD_MS / 1000}s`);
    }

    // Disable if success rate is too low (after minimum attempts)
    if (proxy.stats.total >= 20) {
      const successRate = proxy.stats.success / proxy.stats.total;
      if (successRate < WORKER_CONFIG.PROXY.MIN_SUCCESS_RATE) {
        proxy.status = 'disabled';
        console.error(`[ProxyRotator] Proxy ${proxyID} disabled (success rate: ${(successRate * 100).toFixed(1)}%)`);
      }
    }
  }

  /**
   * Health check all proxies
   */
  async healthCheck() {
    console.log('[ProxyRotator] Running health check...');
    
    const testUrl = 'https://httpbin.org/ip';
    const results = {
      active: 0,
      cooldown: 0,
      disabled: 0,
      total: this.proxies.size,
    };

    for (const [proxyID, proxy] of this.proxies.entries()) {
      results[proxy.status]++;

      // Test active proxies
      if (proxy.status === 'active') {
        try {
          const start = Date.now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);

          await fetch(testUrl, {
            signal: controller.signal,
            headers: { 'Proxy-Authorization': proxy.url }
          });

          clearTimeout(timeout);
          const responseTime = Date.now() - start;

          // Update response time
          if (proxy.stats.total > 0) {
            proxy.stats.avgResponseTime = 
              (proxy.stats.avgResponseTime * 0.9) + (responseTime * 0.1);
          } else {
            proxy.stats.avgResponseTime = responseTime;
          }

          console.log(`[ProxyRotator] ✓ Proxy ${proxyID} healthy (${responseTime}ms)`);
        } catch (err) {
          console.warn(`[ProxyRotator] ✗ Proxy ${proxyID} health check failed:`, err.message);
        }
      }
    }

    console.log('[ProxyRotator] Health check complete:', results);
  }

  /**
   * Start periodic health checks
   */
  startHealthCheck() {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(() => {
      this.healthCheck();
    }, WORKER_CONFIG.PROXY.HEALTH_CHECK_INTERVAL_MS);

    console.log('[ProxyRotator] Health check started');
  }

  /**
   * Get statistics
   */
  getStats() {
    const stats = {
      total: this.proxies.size,
      active: 0,
      cooldown: 0,
      disabled: 0,
      totalRequests: 0,
      successfulRequests: 0,
      avgSuccessRate: 0,
      proxies: [],
    };

    for (const proxy of this.proxies.values()) {
      stats[proxy.status]++;
      stats.totalRequests += proxy.stats.total;
      stats.successfulRequests += proxy.stats.success;

      const successRate = proxy.stats.total > 0 
        ? (proxy.stats.success / proxy.stats.total * 100).toFixed(1)
        : 0;

      stats.proxies.push({
        id: proxy.id,
        country: proxy.country,
        type: proxy.type,
        status: proxy.status,
        requests: proxy.stats.total,
        successRate: `${successRate}%`,
        avgResponseTime: `${proxy.stats.avgResponseTime.toFixed(0)}ms`,
      });
    }

    if (stats.totalRequests > 0) {
      stats.avgSuccessRate = `${(stats.successfulRequests / stats.totalRequests * 100).toFixed(1)}%`;
    }

    return stats;
  }

  /**
   * Log statistics
   */
  logStats() {
    const stats = this.getStats();
    console.log('\n[ProxyRotator] Statistics:');
    console.log(`  Total: ${stats.total} proxies`);
    console.log(`  Active: ${stats.active}, Cooldown: ${stats.cooldown}, Disabled: ${stats.disabled}`);
    console.log(`  Requests: ${stats.totalRequests} total, ${stats.successfulRequests} successful`);
    console.log(`  Success Rate: ${stats.avgSuccessRate}`);
  }

  /**
   * Shutdown
   */
  shutdown() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    console.log('[ProxyRotator] Shutdown complete');
  }
}

// Singleton instance
let rotatorInstance = null;

export function getProxyRotator() {
  if (!rotatorInstance) {
    rotatorInstance = new SmartProxyRotator();
  }
  return rotatorInstance;
}

export default SmartProxyRotator;
