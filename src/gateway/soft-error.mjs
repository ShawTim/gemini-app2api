// Gateway policy for observed whole-answer boilerplates, NOT a native error
// status decoder or a general evaluator of answer quality. Never scan snippets
// or tool arguments for error words and never turn quoted data into failures.
const GENERIC_ERROR_OFFERS = new Set([
  'I seem to be encountering an error. Can I try something else for you?',
  "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
]);
const folded = text => text.replace(/\s+/gu, ' ').trim();
const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
export function softErrorReason(text, body, callCount = 0) {
  if (callCount !== 0 || typeof text !== 'string' || text.length > 1024) return null;
  const signature = folded(text);
  if (!GENERIC_ERROR_OFFERS.has(signature)) return null;
  const messages = body?.messages ?? [];
  const latestUser = messages.findLast(message => message.role === 'user');
  const last = messages.at(-1);
  // Conservative literal-data exemption. This is deliberately not an attempt
  // to infer whether arbitrary instructions are quoting or denying a phrase.
  const literalSources = [latestUser, ...messages.filter(message => ['system', 'developer'].includes(message.role)),
    ...(last?.role === 'tool' ? [last] : [])];
  if (literalSources.some(message => folded(contentText(message?.content)).includes(signature))) return null;
  return 'generic_error_offer';
}
