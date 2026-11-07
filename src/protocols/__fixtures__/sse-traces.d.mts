/** Type declarations for the shared golden-trace fixtures (see sse-traces.mjs). */

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  outputTokenDetails?: { reasoningTokens: number };
}

export interface NormalizedChunk {
  text: string;
  finishReason: string;
  usage?: NormalizedUsage;
}

export const completionsSse: string;
export const completionsExpected: NormalizedChunk;

export const responsesSse: string;
export const responsesExpected: NormalizedChunk;

export const anthropicSse: string;
export const anthropicExpected: { text: string; finishReason: string };

export const oauthTokenResponses: {
  success: { status: number; body: Record<string, unknown> };
  revoked: { status: number; body: Record<string, unknown> };
  slowDown: { status: number; body: Record<string, unknown> };
};

export const planChunkDeltas: string[];
export const planChunkExpectedText: string;
