/**
 * Logger wiring: wraps the cordis `ctx.logger` and optionally mirrors messages
 * to stderr so the operator can see them in the terminal that launched
 * `pnpm dsh web` (DSH's logger may otherwise route to internal sinks). The
 * stderr path uses Node's `util.formatWithOptions` so the format semantics
 * match the cordis logger exactly — no second sprintf implementation.
 */
import { formatWithOptions } from 'node:util'
import type { Logger } from '@deepseek-ai/cordis'
import type { LogSink } from './qqapi.js'

/** Tag prefix shown on every stderr line (e.g. `[qqbot-community]`). */
const STDERR_TAG = '[qqbot-community] '

/** Wall-clock stamp `HH:MM:SS.mmm` for stderr lines. */
function stamp(): string {
  return new Date().toISOString().slice(11, 23)
}

/**
 * Build a LogSink that forwards to the cordis logger and, when `mirror` is
 * true, also writes one line per call to stderr. Errors are always mirrored
 * (they are rare and operators want them without enabling debug).
 */
export function createLogSink(logger: Logger, mirror: boolean): LogSink {
  const write = (level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void => {
    try {
      process.stderr.write(`${STDERR_TAG}${stamp()} ${level} ${message}\n`)
    } catch {
      // stderr itself is unavailable (sandbox / detached test runner); ignore.
    }
  }
  const sink: LogSink = {
    info: (format, ...args) => {
      logger.info(format, ...args)
      if (mirror) write('INFO', formatWithOptions({ colors: false }, format, ...args))
    },
    warn: (format, ...args) => {
      logger.warn(format, ...args)
      if (mirror) write('WARN', formatWithOptions({ colors: false }, format, ...args))
    },
    error: (format, ...args) => {
      logger.error(format, ...args)
      write('ERROR', formatWithOptions({ colors: false }, format, ...args))
    },
  }
  // debug is optional on the cordis Logger; mirror respects both presence and the
  // operator's `debug: true` toggle.
  if (typeof logger.debug === 'function') {
    sink.debug = (format, ...args) => {
      logger.debug(format, ...args)
      if (mirror) write('DEBUG', formatWithOptions({ colors: false }, format, ...args))
    }
  }
  return sink
}