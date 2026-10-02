import OpenAI from 'openai';
import { env } from '../env';

const globalForAi = globalThis as unknown as { __pantryOpenAI?: OpenAI };

export function openai(): OpenAI {
  if (!globalForAi.__pantryOpenAI) {
    globalForAi.__pantryOpenAI = new OpenAI({ apiKey: env.openaiApiKey });
  }
  return globalForAi.__pantryOpenAI;
}

export type ImageInput = { dataUrl: string; detail?: 'low' | 'high' | 'auto' };

type CompleteJsonArgs = {
  model: string;
  system: string;
  user: string;
  images?: ImageInput[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
};

/**
 * One entry point for every model call in the app.
 *
 * Uses JSON-schema structured outputs so downstream code can trust the shape
 * without defensive parsing at each call site — the whole pipeline is
 * model output feeding a relational schema, and a stray field breaks inserts.
 */
export async function completeJson<T>(args: CompleteJsonArgs): Promise<{
  data: T;
  model: string;
  usage: { prompt: number; completion: number } | null;
}> {
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: 'text', text: args.user },
  ];

  for (const image of args.images ?? []) {
    content.push({
      type: 'image_url',
      image_url: { url: image.dataUrl, detail: image.detail ?? 'auto' },
    });
  }

  const response = await openai().chat.completions.create({
    model: args.model,
    temperature: args.temperature ?? 0.2,
    max_tokens: args.maxTokens ?? 4000,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: args.schemaName, strict: true, schema: args.schema },
    },
  });

  const choice = response.choices[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('Model response was truncated; raise maxTokens or split the input.');
  }

  const raw = choice?.message?.content;
  if (!raw) throw new Error('Model returned an empty response');

  return {
    data: JSON.parse(raw) as T,
    model: response.model,
    usage: response.usage
      ? { prompt: response.usage.prompt_tokens, completion: response.usage.completion_tokens }
      : null,
  };
}

/** Shorthand for a required, non-nullable JSON-schema string/number field. */
export const s = {
  string: { type: 'string' } as const,
  number: { type: 'number' } as const,
  boolean: { type: 'boolean' } as const,
  nullableString: { type: ['string', 'null'] } as const,
  nullableNumber: { type: ['number', 'null'] } as const,
};

export function objectSchema(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    // Structured-output strict mode requires every property to be listed.
    required: Object.keys(properties),
    properties,
  };
}
