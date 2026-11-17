import {
  createProvider,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
} from '@earendil-works/pi-ai';
import { registerGeminiAppExtension } from './provider.js';

export default function (pi) {
  registerGeminiAppExtension(pi, {
    createProvider,
    createAssistantMessageEventStream,
    getCurrentSystemPrompt,
    getCurrentTools,
    toToolDeclaration,
  });
}
