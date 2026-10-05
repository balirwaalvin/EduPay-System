/**
 * Minimal structured logger. Emits one JSON object per line in production so
 * platform log aggregators can parse it, and readable text in development.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);
const asJson = process.env.NODE_ENV === 'production';

function emit(level, message, meta) {
    if (LEVELS[level] > activeLevel) return;

    if (asJson) {
        const line = { level, message, time: new Date().toISOString(), ...(meta || {}) };
        process.stdout.write(`${JSON.stringify(line)}\n`);
        return;
    }

    const tag = level.toUpperCase().padEnd(5);
    const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[${tag}] ${message}${extra}`);
}

module.exports = {
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta)
};
