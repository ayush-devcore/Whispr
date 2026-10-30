import test from 'node:test';
import assert from 'node:assert/strict';
import { getBrowserE2EConfig } from './browser-e2e-config.js';

test('browser E2E remains opt-in and gives the normal journey a clear skip reason', () => {
  const config = getBrowserE2EConfig({});
  assert.equal(config.browserOptedIn, false);
  assert.match(config.browserSkipReason, /RUN_BROWSER_E2E=true/);
  assert.equal(config.aiBrowserOptIn, false);
});

test('browser E2E opt-in enables the synthetic journey but not billable AI requests', () => {
  const config = getBrowserE2EConfig({ RUN_BROWSER_E2E: 'true', OPENROUTER_API_KEY: 'test-key' });
  assert.equal(config.browserOptedIn, true);
  assert.equal(config.browserSkipReason, false);
  assert.equal(config.aiBrowserOptIn, false);
  assert.match(config.aiSkipReason, /RUN_BROWSER_AI_E2E=true/);
});

test('browser AI opt-in uses only the selected provider credential and model', () => {
  const gemini = getBrowserE2EConfig({ RUN_BROWSER_E2E: 'true', RUN_BROWSER_AI_E2E: 'true', GEMINI_API_KEY: 'gemini-key' });
  assert.equal(gemini.aiBrowserOptIn, true);
  assert.equal(gemini.aiCredentialVariable, 'GEMINI_API_KEY');
  assert.equal(gemini.aiProvider, 'gemini');
  assert.equal(gemini.aiModel, 'gemini-3.5-flash-lite');

  const router = getBrowserE2EConfig({ RUN_BROWSER_E2E: 'true', RUN_BROWSER_AI_E2E: 'true', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'router-key', OPENAI_API_KEY: 'openai-key' });
  assert.equal(router.aiBrowserOptIn, true);
  assert.equal(router.aiCredentialVariable, 'OPENROUTER_API_KEY');
  assert.equal(router.aiProvider, 'openrouter');
  assert.equal(router.aiModel, 'openai/gpt-6-luna');

  const missingOpenAI = getBrowserE2EConfig({ RUN_BROWSER_AI_E2E: 'true', AI_PROVIDER: 'openai', OPENROUTER_API_KEY: 'router-key' });
  assert.equal(missingOpenAI.aiBrowserOptIn, false);
  assert.equal(missingOpenAI.aiCredentialVariable, 'OPENAI_API_KEY');
  assert.match(missingOpenAI.aiSkipReason, /OPENAI_API_KEY/);
});
