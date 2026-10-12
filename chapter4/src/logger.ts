import { createLogger, format, transports } from 'winston';

type LogValue = string | Error;
type LoggerState = {
    logger: ReturnType<typeof createLogger>;
    lastKey?: string;
    consecutiveCount: number;
    ellipsisPrinted: boolean;
};

type LoggerWrapper = {
    debug(value: LogValue, sampleCount?: number): void;
    debug(filename: string, value: LogValue, sampleCount?: number): void;
    info(value: LogValue, sampleCount?: number): void;
    info(filename: string, value: LogValue, sampleCount?: number): void;
    error(value: LogValue, sampleCount?: number): void;
    error(filename: string, value: LogValue, sampleCount?: number): void;
};

function createLoggerWrapper() {
    const loggers = new Map<string, LoggerState>();

    function getLogger(filename?: string): LoggerState {
        const key = filename ?? '__console__';
        const existing = loggers.get(key);
        if (existing !== undefined)
            return existing;

        const isConsole = filename === undefined;
        const loggerFormat = format.combine(
            format.timestamp(),
            format.errors({ stack: true }),
            ...(isConsole ? [format.colorize()] : []),
            format.printf(({ timestamp, level, message, stack }) => {
                return `[${level}] ${stack ?? message}`;
            }),
        );

        const state: LoggerState = {
            logger: createLogger({
                level: 'debug',
                format: loggerFormat,
                transports: isConsole
                    ? [new transports.Console()]
                    : [new transports.File({ filename: filename as string, level: 'debug', options: { flags: 'w' } })],
            }),
            consecutiveCount: 0,
            ellipsisPrinted: false,
        };
        loggers.set(key, state);
        return state;
    }

    function write(level: 'debug' | 'info' | 'error', filename: string | undefined, value: LogValue, limit: number): void {
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error('sampleCount must be a positive integer');
        }

        const state = getLogger(filename);
        // Use the stable message for sampling; stack traces often differ by line.
        const content = value instanceof Error ? value.message : value;
        const key = `${level}:${content}`;
        if (key !== state.lastKey) {
            state.lastKey = key;
            state.consecutiveCount = 0;
            state.ellipsisPrinted = false;
        }

        if (state.consecutiveCount < limit) {
            state.consecutiveCount += 1;
            state.logger.log(level, value);
            return;
        }

        if (!state.ellipsisPrinted) {
            state.ellipsisPrinted = true;
            state.logger.log(level, '...');
        }
    }

    const wrapper: LoggerWrapper = {
        info: (first: string | Error, second?: LogValue | number, third = 2): void => {
            if (typeof second === 'number' || second === undefined) {
                write('info', undefined, first, second ?? 2);
                return;
            }
            if (typeof first !== 'string') {
                throw new Error('filename must be a string when a log value is provided');
            }
            write('info', first, second as LogValue, third as number);
        },
        error: (first: string | Error, second?: LogValue | number, third = 2): void => {
            if (typeof second === 'number' || second === undefined) {
                write('error', undefined, first, second ?? 2);
                return;
            }
            if (typeof first !== 'string') {
                throw new Error('filename must be a string when a log value is provided');
            }
            write('error', first, second as LogValue, third as number);
        },
        debug: (first: string | Error, second?: LogValue | number, third = 2): void => {
            if (typeof second === 'number' || second === undefined) {
                write('debug', undefined, first, second ?? 2);
                return;
            }
            if (typeof first !== 'string') {
                throw new Error('filename must be a string when a log value is provided');
            }
            write('debug', first, second as LogValue, third as number);
        },
    };
    return wrapper;
}

export const logger = createLoggerWrapper();
