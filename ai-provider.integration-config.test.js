import test from 'node:test';
import assert from 'node:assert/strict';
import { getAIIntegrationConfig, providerFailureDiagnostic, safeProviderFailure } from './ai-provider.integration-config.js';

test('AI integration selects the matching OpenRouter credential, endpoint, and model', () => {
  const config = getAIIntegrationConfig({
    RUN_AI_INTEGRATION: 'true', AI_ENABLED: 'true', AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'router-test-key', OPENAI_API_KEY: 'openai-test-key'
  });
  assert.equal(config.credentialVariable, 'OPENROUTER_API_KEY');
  assert.equal(config.apiKey, 'router-test-key');
  assert.equal(config.endpointHost, 'openrouter.ai');
  assert.equal(config.model, 'openai/gpt-6-luna');
  assert.equal(config.skipReason, false);
});

test('AI integration selects Gemini credentials, direct Google endpoint, and Flash-Lite default', () => {
  const config = getAIIntegrationConfig({
    RUN_AI_INTEGRATION: 'true', AI_ENABLED: 'true', AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-test-key', OPENROUTER_API_KEY: 'router-test-key', OPENAI_API_KEY: 'openai-test-key'
  });
  assert.equal(config.credentialVariable, 'GEMINI_API_KEY');
  assert.equal(config.apiKey, 'gemini-test-key');
  assert.equal(config.endpointHost, 'generativelanguage.googleapis.com');
  assert.equal(config.model, 'gemini-3.5-flash-lite');
  assert.equal(config.skipReason, false);
});

test('Gemini integration does not borrow OpenAI or OpenRouter credentials', () => {
  const config = getAIIntegrationConfig({
    RUN_AI_INTEGRATION: 'true', AI_ENABLED: 'true', AI_PROVIDER: 'gemini',
    OPENROUTER_API_KEY: 'router-test-key', OPENAI_API_KEY: 'openai-test-key'
  });
  assert.equal(config.credentialVariable, 'GEMINI_API_KEY');
  assert.equal(config.apiKey, undefined);
  assert.match(config.skipReason, /AI_PROVIDER=gemini requires GEMINI_API_KEY/);
});

test('AI integration selects the matching OpenAI credential without borrowing OpenRouter credentials', () => {
  const config = getAIIntegrationConfig({
    RUN_AI_INTEGRATION: 'true', AI_ENABLED: 'true', AI_PROVIDER: 'openai',
    OPENROUTER_API_KEY: 'router-test-key'
  });
  assert.equal(config.credentialVariable, 'OPENAI_API_KEY');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.endpointHost, 'api.openai.com');
  assert.equal(config.model, 'gpt-6-luna');
  assert.match(config.skipReason, /AI_PROVIDER=openai requires OPENAI_API_KEY/);
});

test('OpenRouter integration does not borrow an OpenAI credential when its own key is missing', () => {
  const config = getAIIntegrationConfig({
    RUN_AI_INTEGRATION: 'true', AI_ENABLED: 'true', AI_PROVIDER: 'openrouter',
    OPENAI_API_KEY: 'openai-test-key'
  });
  assert.equal(config.credentialVariable, 'OPENROUTER_API_KEY');
  assert.equal(config.apiKey, undefined);
  assert.match(config.skipReason, /AI_PROVIDER=openrouter requires OPENROUTER_API_KEY/);
});

test('AI integration defaults to Gemini and explains opt-in skips', () => {
  const config = getAIIntegrationConfig({ OPENROUTER_API_KEY: 'router-test-key' });
  assert.equal(config.providerName, 'gemini');
  assert.match(config.skipReason, /RUN_AI_INTEGRATION=true/);
});

test('AI integration explains unsupported provider and disabled inference', () => {
  assert.match(getAIIntegrationConfig({ RUN_AI_INTEGRATION: 'true', AI_PROVIDER: 'other' }).skipReason, /AI_PROVIDER must be gemini, openrouter, or openai/);
  assert.match(getAIIntegrationConfig({ RUN_AI_INTEGRATION: 'true', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'router-test-key', AI_ENABLED: 'false' }).skipReason, /AI_ENABLED=false/);
});

test('OpenRouter HTTP 402 reports the account or model blocker without leaking provider details', () => {
  const message = safeProviderFailure(Object.assign(new Error('secret response body'), { status: 402 }), 'openrouter');
  assert.match(message, /HTTP 402/);
  assert.match(message, /credits, spending limits, and model\/provider availability/);
  assert.doesNotMatch(message, /secret response body/);
});

test('Gemini quota, authorization, and unavailable model errors report safe actionable categories', () => {
  assert.match(safeProviderFailure({ status: 429 }, 'gemini'), /Gemini.*HTTP 429.*quota, rate limits, and billing/);
  assert.match(safeProviderFailure({ status: 403 }, 'gemini'), /GEMINI_API_KEY.*API restrictions/);
  assert.match(safeProviderFailure({ status: 404 }, 'gemini'), /configured model.*HTTP 404/);
});

test('Gemini HTTP 400 reports only a safe request-field diagnosis and allowlisted metadata', () => {
  const rawMessage = JSON.stringify({ error: {
    code: 400,
    status: 'INVALID_ARGUMENT',
    message: 'Invalid JSON payload received. Unknown name "responseJsonSchema" at generationConfig. Private synthetic prompt text must never be shown.'
  } });
  const error = Object.assign(new Error(rawMessage), {
    status: 400,
    headers: new Headers({ 'x-goog-request-id': 'request-test-123' })
  });
  const diagnostic = providerFailureDiagnostic(error, 'gemini', 'smart replies');
  assert.deepEqual(diagnostic, {
    provider: 'gemini', operation: 'smart replies', httpStatus: 400,
    providerCode: 'INVALID_ARGUMENT',
    message: 'Gemini rejected unknown request field "responseJsonSchema".',
    requestId: 'request-test-123'
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /Private synthetic prompt text|response body/);
});
