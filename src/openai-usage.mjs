// The gateway estimates Chat-shaped usage internally. Responses has different
// required counter names. Preserve the estimate label; do not invent unmeasured
// cache/reasoning breakdowns or expose Chat-only counter names on Responses.
export const CHARS_PER_TOKEN = 3.5;
// Standard Gemini vision tile estimate so base64 image payloads never inflate
// prompt_tokens by hundreds of thousands of bogus text tokens.
export const TOKENS_PER_IMAGE = 258;

export function measurePromptImagePayload(body) {
  let imageCount = 0;
  let imageUrlChars = 0;
  const scanParts = (parts) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
        imageCount++;
        imageUrlChars += part.image_url.url.length;
      } else if (part.type === 'input_image' && typeof part.image_url === 'string') {
        imageCount++;
        imageUrlChars += part.image_url.length;
      }
    }
  };
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) scanParts(message?.content);
  }
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === 'input_image' && typeof item.image_url === 'string') {
        imageCount++;
        imageUrlChars += item.image_url.length;
      } else {
        scanParts(item?.content);
        scanParts(item?.output);
      }
    }
  }
  return { imageCount, imageUrlChars };
}

export function estimateUsage({ promptChars = 0, imageCount = 0, outputBytes = 0 } = {}) {
  const safePrompt = Number.isFinite(promptChars) && promptChars > 0 ? promptChars : 0;
  const safeImages = Number.isInteger(imageCount) && imageCount > 0 ? imageCount : 0;
  const safeOutput = Number.isFinite(outputBytes) && outputBytes > 0 ? outputBytes : 0;
  const prompt = Math.ceil(safePrompt / CHARS_PER_TOKEN) + safeImages * TOKENS_PER_IMAGE;
  const completion = Math.ceil(safeOutput / CHARS_PER_TOKEN);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    estimated: true,
  };
}

export function toResponsesUsage(usage) {
  if (usage == null) return null;
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens,
    output_tokens: usage.output_tokens ?? usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.estimated === true ? { estimated: true } : {}),
    ...(usage.input_tokens_details != null ? { input_tokens_details: usage.input_tokens_details } : {}),
    ...(usage.output_tokens_details != null ? { output_tokens_details: usage.output_tokens_details } : {}),
  };
}
