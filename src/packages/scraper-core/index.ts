/**
 * scraper-core/index.ts — single import surface.
 * Plugins should only ever import from "@compx/scraper-core", never reach
 * into a subfolder directly.
 * 
 * ✅ FIX: Updated for Supabase-only architecture (No Redis).
 */

// Core Contracts & Types
export * from "./contract.js";
export * from "./errors.js";
export * from "./capabilityRegistry.js";

// Billing & Access Control
export * from "./credits.js";
export * from "./access.js";

// Browser Management (Stealth + Pooling)
export * from "./browser/browser-manager.js";
export * from "./browser/browser-pool.js";

// Proxy & Routing (Supabase-based State)
export * from "./proxy/proxy-manager.js";
export * from "./proxy/routing-engine.js";

// Parsers & Validation
export * from "./parser/domain.js";
export * from "./parser/email.js";
export * from "./validation/validator.js";

// Storage & Caching (Supabase-native)
export * from "./storage/uploader.js";
export * from "./storage/cache.js"; // ✅ Primary cache interface
// export * from "./cacheService.js"; // ❌ Removed if redundant with storage/cache.js

// Circuit Breaker & Metrics (Supabase Advisory Locks + JSONB)
export * from "./circuit-breaker.js"; // ✅ Fixed filename casing
export * from "./metrics.js";          // ✅ Now uses provider_metrics table

// Provider Abstraction Layer
export * from "./provider.js";

// Session Management (Supabase Persistent Sessions)
export * from "./session/session-manager.js";

// Utilities
export * from "./utils/logger.js";
export * from "./alerting.js";

// Crawlee Integration (if still used)
export * from "./crawler/crawler-factory.js";