// The gateway estimates Chat-shaped usage internally. Responses has different
// required counter names. Preserve the estimate label; do not invent unmeasured
// cache/reasoning breakdowns or expose Chat-only counter names on Responses.
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
