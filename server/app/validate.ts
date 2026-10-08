// Validates /api/analyze request bodies so bad input gets a clear 400
// instead of a confusing model response or a crash deep in the pipeline.

export interface AnalyzeRequest {
  screenshot?: string;
  transcript: string;
  question?: string;
  stream: boolean;
}

export const LIMITS = {
  transcriptChars: 20_000,
  questionChars: 2_000,
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type ValidationResult = { ok: true; value: AnalyzeRequest } | { ok: false; error: string };

function optionalString(body: Record<string, unknown>, key: string): string | undefined | Error {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return new Error(`"${key}" must be a string`);
  return value;
}

export function validateAnalyzeBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;

  const screenshot = optionalString(record, 'screenshot');
  if (screenshot instanceof Error) return { ok: false, error: screenshot.message };
  if (screenshot !== undefined && (screenshot.length % 4 !== 0 || !BASE64.test(screenshot))) {
    return { ok: false, error: '"screenshot" must be base64-encoded image data (no data: URL prefix)' };
  }

  const transcript = optionalString(record, 'transcript');
  if (transcript instanceof Error) return { ok: false, error: transcript.message };
  if (transcript !== undefined && transcript.length > LIMITS.transcriptChars) {
    return { ok: false, error: `"transcript" must be at most ${LIMITS.transcriptChars} characters` };
  }

  const question = optionalString(record, 'question');
  if (question instanceof Error) return { ok: false, error: question.message };
  const trimmedQuestion = question?.trim() || undefined;
  if (trimmedQuestion !== undefined && trimmedQuestion.length > LIMITS.questionChars) {
    return { ok: false, error: `"question" must be at most ${LIMITS.questionChars} characters` };
  }

  const stream = record.stream;
  if (stream !== undefined && typeof stream !== 'boolean') {
    return { ok: false, error: '"stream" must be a boolean' };
  }

  if (!screenshot && !transcript?.trim() && !trimmedQuestion) {
    return { ok: false, error: 'Nothing to analyze: send a screenshot, a transcript, or a question' };
  }

  return {
    ok: true,
    value: {
      screenshot: screenshot || undefined,
      transcript: transcript || '',
      question: trimmedQuestion,
      stream: stream !== false,
    },
  };
}
