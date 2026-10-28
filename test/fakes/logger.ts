// The in-memory Logger for tests: the real redacting logger
// (src/privacy/logger.ts) over a sink that records each finished line, so a
// test asserts on exactly what production would have written.
import { createLogger, type Logger, type LogLevel } from '../../src/privacy/logger';

export interface RecordedLine {
  readonly level: LogLevel;
  readonly line: string;
}

export interface RecordingLogger {
  readonly logger: Logger;
  /** Every line, in order, as the console sink would have received it. */
  readonly lines: readonly RecordedLine[];
  /** The lines parsed back into objects. */
  records(): Record<string, unknown>[];
  /** All the lines in one string, for "contains none of" assertions. */
  text(): string;
}

export function recordingLogger(): RecordingLogger {
  const lines: RecordedLine[] = [];
  return {
    logger: createLogger((level, line) => {
      lines.push({ level, line });
    }),
    lines,
    records: () => lines.map(({ line }) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.map(({ line }) => line).join('\n'),
  };
}
