/**
 * AI-backed helpers the routers call. The Cloudflare build resolves
 * `#ai-features` to ./ai-features.workerd.ts instead (package.json
 * "imports"), so neither @openpanel/ai nor Better Agent reaches the API
 * Worker bundle.
 */
export { generateInsightExplanation } from '@openpanel/ai';
export { runFilterCommand } from './agents/filter-command';

export const AI_FEATURES_AVAILABLE: boolean = true;
