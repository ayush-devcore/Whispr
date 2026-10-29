import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService, createProviderClient } from './ai-service.js';

function mockClient(output, status = 'completed') {
  const requests = [];
  return { requests, client: { responses: { create: async (...args) => { requests.push(args); return { status, output_text: typeof output === 'string' ? output : JSON.stringify(output) }; } } } };
}

test('AI calls use Responses API structured output without storing provider state', async () => {
  const mock = mockClient({ replies: ['A useful reply', 'A second option'] });
  const ai = createAIService({ client: mock.client, enabled: true, providerName: 'openrouter', model: 'openai/gpt-6-luna' });
  assert.deepEqual(await ai.smartReplies({ history: [{ text: 'A question' }] }), { replies: ['A useful reply', 'A second option'] });
  const [request, options] = mock.requests[0];
  assert.equal(request.model, 'openai/gpt-6-luna');
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.provider, { require_parameters: true });
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeout, 20_000);
  assert.match(request.instructions, /untrusted quoted data/);
});

test('OpenAI selection sends requests to OpenAI without OpenRouter-only routing', async () => {
  const mock = mockClient({ replies: ['A draft'] });
  const ai = createAIService({ client: mock.client, enabled: true, providerName: 'openai', model: 'gpt-6-luna' });
  await ai.smartReplies({ history: [] });
  const [request] = mock.requests[0];
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(Object.hasOwn(request, 'provider'), false);
});

test('provider selection uses OpenRouter base URL and preserves the OpenAI endpoint', () => {
  const router = createProviderClient({ providerName: 'openrouter', apiKey: 'test-only-not-a-real-secret', timeoutMs: 4321 });
  assert.equal(router.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(router.timeout, 4321);
  assert.equal(router.maxRetries, 0);
  const openai = createProviderClient({ providerName: 'openai', apiKey: 'test-only-not-a-real-secret' });
  assert.equal(openai.baseURL, 'https://api.openai.com/v1');
});

test('provider selection reads the matching server credential and model defaults', () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldModel = process.env.AI_MODEL;
  try {
    process.env.OPENROUTER_API_KEY = 'test-only-not-a-real-secret';
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_MODEL;
    const router = createAIService({ enabled: true, providerName: ' OpenRouter ' });
    assert.equal(router.configured, true);
    assert.equal(router.providerName, 'openrouter');
    assert.equal(router.model, 'openai/gpt-6-luna');
    const missingOpenAI = createAIService({ enabled: true, providerName: 'openai' });
    assert.equal(missingOpenAI.configured, false);
  } finally {
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAIKey;
    if (oldModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = oldModel;
  }
});

test('missing credentials and unsupported provider fail closed without a client', async () => {
  const missing = createAIService({ enabled: true, providerName: 'openrouter', apiKey: '' });
  assert.equal(missing.configured, false);
  await assert.rejects(missing.summary({}), { code: 'AI_UNAVAILABLE' });
  const unsupported = createAIService({ enabled: true, providerName: 'other-provider', apiKey: 'test-only-not-a-real-secret' });
  assert.equal(unsupported.configured, false);
  await assert.rejects(unsupported.summary({}), { code: 'AI_UNAVAILABLE' });
  assert.throws(() => createProviderClient({ providerName: 'openrouter', apiKey: '' }), /credentials are missing/);
  assert.throws(() => createProviderClient({ providerName: 'other-provider', apiKey: 'test-only-not-a-real-secret' }), /Unsupported AI provider/);
});

test('AI requests pass the configured strict timeout to the provider SDK', async () => {
  const mock = mockClient({ replies: [] });
  const ai = createAIService({ client: mock.client, timeoutMs: 3210 });
  await ai.smartReplies({ history: [] });
  assert.equal(mock.requests[0][1].timeout, 3210);
  assert.equal(mock.requests[0][1].maxRetries, 0);
});

test('AI service handles unavailable provider, malformed data, and incomplete responses', async () => {
  const unavailable = createAIService({ client: false });
  await assert.rejects(unavailable.summary({}), { code: 'AI_UNAVAILABLE' });
  const invalid = createAIService({ client: mockClient({ replies: ['x'.repeat(301)] }).client });
  await assert.rejects(invalid.smartReplies({}), /failed validation/);
  const incomplete = createAIService({ client: mockClient({ replies: [] }, 'incomplete').client });
  await assert.rejects(incomplete.smartReplies({}), /completed result/);
});

test('scam classification is range-validated and normalized to the risk score', async () => {
  const mock = mockClient({ riskScore: 90, severity: 'low', categories: ['phishing'], explanation: 'A risk estimate.', evidence: ['urgent password request'], nextSteps: ['Do not share credentials.'], uncertain: true });
  const ai = createAIService({ client: mock.client });
  const result = await ai.scamAnalysis({ target: { text: 'Please send your password urgently.' } });
  assert.equal(result.severity, 'critical');
  assert.equal(result.uncertain, true);
  const invalid = createAIService({ client: mockClient({ riskScore: 120, severity: 'critical', categories: [], explanation: '', evidence: [], nextSteps: [], uncertain: true }).client });
  await assert.rejects(invalid.scamAnalysis({}), /failed validation/);
});

test('search results are restricted to the supplied authorized candidate IDs', async () => {
  const ai = createAIService({ client: mockClient({ messageIds: ['allowed', 'unauthorized'] }).client });
  assert.deepEqual(await ai.search('the project date', [{ id: 'allowed', text: 'Friday' }]), ['allowed']);
});

test('provider failures are surfaced without fabricating a result', async () => {
  const client = { responses: { create: async () => { const error = new Error('private prompt details'); error.status = 429; throw error; } } };
  const ai = createAIService({ client });
  await assert.rejects(ai.summary({}), (error) => error.status === 429 && error.message === 'private prompt details');
});
