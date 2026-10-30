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

test('Gemini uses its GenerateContent JSON-schema API with a bounded request and no OpenAI-only fields', async () => {
  const requests = [];
  const client = { models: { generateContent: async (request) => { requests.push(request); return { text: JSON.stringify({ replies: ['A useful draft'] }), candidates: [{ finishReason: 'STOP' }] }; } } };
  const ai = createAIService({ client, enabled: true, providerName: 'gemini', model: 'gemini-3.5-flash-lite', timeoutMs: 4321, maxOutputTokens: 600 });
  assert.deepEqual(await ai.smartReplies({ conversationType: 'direct', history: [{ text: 'A synthetic question' }] }), { replies: ['A useful draft'] });
  const request = requests[0];
  assert.equal(request.model, 'gemini-3.5-flash-lite');
  assert.equal(request.contents, JSON.stringify({ conversationType: 'direct', history: [{ text: 'A synthetic question' }] }));
  assert.match(request.config.systemInstruction, /untrusted quoted data/);
  assert.equal(request.config.responseMimeType, 'application/json');
  assert.equal(request.config.responseJsonSchema.type, 'object');
  assert.ok(request.config.responseJsonSchema.properties.replies);
  assert.equal(request.config.maxOutputTokens, 250);
  assert.equal(request.config.httpOptions.timeout, 4321);
  assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
  assert.equal(Object.hasOwn(request.config, 'responseSchema'), false);
  assert.equal(Object.hasOwn(request.config, 'store'), false);
  assert.equal(Object.hasOwn(request, 'provider'), false);
});

test('Gemini rejects malformed, blocked, and quota-limited responses without a fabricated result', async () => {
  const invalidJson = createAIService({ providerName: 'gemini', client: { models: { generateContent: async () => ({ text: 'not json', candidates: [{ finishReason: 'STOP' }] }) } } });
  await assert.rejects(invalidJson.smartReplies({}), /invalid structured result/);

  const blocked = createAIService({ providerName: 'gemini', client: { models: { generateContent: async () => ({ text: '', candidates: [{ finishReason: 'SAFETY' }] }) } } });
  await assert.rejects(blocked.smartReplies({}), { code: 'AI_RESPONSE_BLOCKED' });

  const quotaError = Object.assign(new Error('private provider body'), { status: 429 });
  const quotaLimited = createAIService({ providerName: 'gemini', client: { models: { generateContent: async () => { throw quotaError; } } } });
  await assert.rejects(quotaLimited.smartReplies({}), (error) => error === quotaError && error.status === 429);
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
  const gemini = createProviderClient({ providerName: 'gemini', apiKey: 'test-only-not-a-real-secret', timeoutMs: 4321 });
  assert.equal(gemini.apiClient.clientOptions.httpOptions.baseUrl, 'https://generativelanguage.googleapis.com/');
  assert.equal(gemini.httpOptions.timeout, 4321);
  assert.equal(gemini.httpOptions.retryOptions.attempts, 1);
  assert.equal(gemini.apiKey, 'test-only-not-a-real-secret');
  assert.equal(gemini.vertexai, false);
});

test('provider selection reads the matching server credential and model defaults', () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  const oldProvider = process.env.AI_PROVIDER;
  const oldModel = process.env.AI_MODEL;
  try {
    process.env.OPENROUTER_API_KEY = 'test-only-not-a-real-secret';
    process.env.GEMINI_API_KEY = 'gemini-test-only-not-a-real-secret';
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_MODEL;
    const router = createAIService({ enabled: true, providerName: ' OpenRouter ' });
    assert.equal(router.configured, true);
    assert.equal(router.providerName, 'openrouter');
    assert.equal(router.model, 'openai/gpt-6-luna');
    const gemini = createAIService({ enabled: true, providerName: 'gemini' });
    assert.equal(gemini.configured, true);
    assert.equal(gemini.providerName, 'gemini');
    assert.equal(gemini.model, 'gemini-3.5-flash-lite');
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
    const defaultGeminiWithoutKey = createAIService({ enabled: true });
    assert.equal(defaultGeminiWithoutKey.providerName, 'gemini');
    assert.equal(defaultGeminiWithoutKey.configured, false, 'default Gemini must not borrow the available OpenRouter key');
    const missingOpenAI = createAIService({ enabled: true, providerName: 'openai' });
    assert.equal(missingOpenAI.configured, false);
  } finally {
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAIKey;
    if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGeminiKey;
    if (oldProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = oldModel;
  }
});

test('missing credentials and unsupported provider fail closed without a client', async () => {
  const missing = createAIService({ enabled: true, providerName: 'openrouter', apiKey: '' });
  assert.equal(missing.configured, false);
  await assert.rejects(missing.summary({}), { code: 'AI_UNAVAILABLE' });
  const missingGemini = createAIService({ enabled: true, providerName: 'gemini', apiKey: '' });
  assert.equal(missingGemini.configured, false);
  assert.equal(missingGemini.diagnostics.credentialVariable, 'GEMINI_API_KEY');
  await assert.rejects(missingGemini.summary({}), { code: 'AI_UNAVAILABLE' });
  const unsupported = createAIService({ enabled: true, providerName: 'other-provider', apiKey: 'test-only-not-a-real-secret' });
  assert.equal(unsupported.configured, false);
  await assert.rejects(unsupported.summary({}), { code: 'AI_UNAVAILABLE' });
  assert.throws(() => createProviderClient({ providerName: 'openrouter', apiKey: '' }), /credentials are missing/);
  assert.throws(() => createProviderClient({ providerName: 'other-provider', apiKey: 'test-only-not-a-real-secret' }), /Unsupported AI provider/);
});

test('AI requests pass the configured strict timeout to the provider SDK', async () => {
  const mock = mockClient({ replies: [] });
  const ai = createAIService({ client: mock.client, providerName: 'openai', timeoutMs: 3210 });
  await ai.smartReplies({ history: [] });
  assert.equal(mock.requests[0][1].timeout, 3210);
  assert.equal(mock.requests[0][1].maxRetries, 0);
});

test('AI service handles unavailable provider, malformed data, and incomplete responses', async () => {
  const unavailable = createAIService({ client: false });
  await assert.rejects(unavailable.summary({}), { code: 'AI_UNAVAILABLE' });
  const invalid = createAIService({ client: mockClient({ replies: ['x'.repeat(301)] }).client, providerName: 'openai' });
  await assert.rejects(invalid.smartReplies({}), /failed validation/);
  const incomplete = createAIService({ client: mockClient({ replies: [] }, 'incomplete').client, providerName: 'openai' });
  await assert.rejects(incomplete.smartReplies({}), /completed result/);
});

test('scam classification is range-validated and normalized to the risk score', async () => {
  const mock = mockClient({ riskScore: 90, severity: 'low', categories: ['phishing'], explanation: 'A risk estimate.', evidence: ['urgent password request'], nextSteps: ['Do not share credentials.'], uncertain: true });
  const ai = createAIService({ client: mock.client, providerName: 'openai' });
  const result = await ai.scamAnalysis({ target: { text: 'Please send your password urgently.' } });
  assert.equal(result.severity, 'critical');
  assert.equal(result.uncertain, true);
  const invalid = createAIService({ client: mockClient({ riskScore: 120, severity: 'critical', categories: [], explanation: '', evidence: [], nextSteps: [], uncertain: true }).client, providerName: 'openai' });
  await assert.rejects(invalid.scamAnalysis({}), /failed validation/);
});

test('search results are restricted to the supplied authorized candidate IDs', async () => {
  const ai = createAIService({ client: mockClient({ messageIds: ['allowed', 'unauthorized'] }).client, providerName: 'openai' });
  assert.deepEqual(await ai.search('the project date', [{ id: 'allowed', text: 'Friday' }]), ['allowed']);
});

test('AI link analysis returns bounded structured results and normalizes risk severity', async () => {
  const mock = mockClient({ links: [{
    url: 'https://paypal-login.example/verify',
    riskScore: 78,
    severity: 'low',
    explanation: 'The hostname resembles a brand login page.',
    indicators: ['possible brand impersonation'],
    recommendations: ['Open the official website manually.'],
    uncertain: false
  }] });
  const ai = createAIService({ client: mock.client, providerName: 'openai' });
  const result = await ai.linkAnalysis({ links: [{ url: 'https://paypal-login.example/verify', signals: ['possible_brand_impersonation'] }] });
  assert.equal(result.links[0].severity, 'high');
  assert.equal(result.links[0].uncertain, true);
  assert.equal(result.links[0].url, 'https://paypal-login.example/verify');
  assert.match(mock.requests[0][0].instructions, /Never open, fetch, resolve, expand, or follow/);
});

test('AI link analysis rejects malformed or oversized structured output', async () => {
  const malformed = createAIService({ client: mockClient({ links: [{ url: 'https://example.com', riskScore: 101, severity: 'critical', explanation: '', indicators: [], recommendations: [], uncertain: true }] }).client, providerName: 'openai' });
  await assert.rejects(malformed.linkAnalysis({ links: [] }), /failed validation/);
  const tooMany = createAIService({ client: mockClient({ links: Array.from({ length: 6 }, () => ({ url: 'https://example.com', riskScore: 0, severity: 'low', explanation: 'No obvious pattern.', indicators: [], recommendations: [], uncertain: true })) }).client, providerName: 'openai' });
  await assert.rejects(tooMany.linkAnalysis({ links: [] }), /failed validation/);
});

test('provider failures are surfaced without fabricating a result', async () => {
  const client = { responses: { create: async () => { const error = new Error('private prompt details'); error.status = 429; throw error; } } };
  const ai = createAIService({ client, providerName: 'openai' });
  await assert.rejects(ai.summary({}), (error) => error.status === 429 && error.message === 'private prompt details');
});
