import * as piAi from '@earendil-works/pi-ai';
import { registerGeminiAppExtension } from './provider.js';

export default function (pi) {
  registerGeminiAppExtension(pi, {
    createProvider: piAi.createProvider,
    createAssistantMessageEventStream: piAi.createAssistantMessageEventStream,
    getCurrentSystemPrompt: piAi.getCurrentSystemPrompt,
    getCurrentTools: piAi.getCurrentTools,
    toToolDeclaration: piAi.toToolDeclaration,
  });
}
