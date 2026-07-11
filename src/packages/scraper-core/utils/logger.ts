/**
 * scraper-core/utils/logger.ts
 *
 * The old worker/lib/terminalLogger.js (referenced by hiringSignalsJob.js as
 * createLogger()) wasn't in the uploaded files, but its usage pattern
 * (buffered logs, one flush on .close()) is clear from the call sites. This
 * is the scraper-core version: any plugin can get a per-job buffered logger
 * without a direct Supabase dependency — it takes a sink function instead,
 * so plugins/tests can swap in console.log, Supabase, or a no-op.
 */

export type LogSink = (jobId: string, lines: string[]) => Promise<void> | void;

export interface JobLogger {
  log: (line: string) => Promise<void>;
  close: () => Promise<void>;
}

export function createLogger(jobId: string, sink?: LogSink, flushEvery = 10): JobLogger {
  const buffer: string[] = [];

  const flush = async () => {
    if (!buffer.length) return;
    const toFlush = buffer.splice(0, buffer.length);
    if (sink) {
      await sink(jobId, toFlush);
    } else {
      // eslint-disable-next-line no-console
      toFlush.forEach((l) => console.log(`[job:${jobId}] ${l}`));
    }
  };

  return {
    async log(line: string) {
      const ts = new Date().toISOString();
      buffer.push(`${ts} ${line}`);
      if (buffer.length >= flushEvery) await flush();
    },
    async close() {
      await flush();
    },
  };
}

/** Supabase-backed sink, matching the old terminalLogger.js behavior — writes into a `job_logs` table in batches instead of one row per log line. */
export function supabaseLogSink(supabase: any, table = "job_logs"): LogSink {
  return async (jobId, lines) => {
    if (!lines.length) return;
    try {
      await supabase.from(table).insert(
        lines.map((line) => ({ job_id: jobId, line, created_at: new Date().toISOString() }))
      );
    } catch (err: any) {
      console.error(`[Logger] Failed to flush logs for job ${jobId}:`, err.message);
    }
  };
}
