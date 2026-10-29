import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOpenRouterKey } from './openrouter-diagnostics.js';

test('OpenRouter key diagnostic skips requests when the credential is missing', async () => {
  let called = false;
  const result = await checkOpenRouterKey({ apiKey: '', fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.category, 'credential_missing');
  assert.equal(result.endpointHost, 'openrouter.ai');
});

test('OpenRouter key diagnostic sends server authorization and returns only safe metadata', async () => {
  let endpoint;
  let method;
  let authorizationPresent = false;
  const result = await checkOpenRouterKey({
    apiKey: 'test-only-not-a-real-secret',
    fetchImpl: async (url, options) => {
      endpoint = url;
      method = options.method;
      authorizationPresent = options.headers.Authorization.startsWith('Bearer ');
      return { ok: true, status: 200, headers: new Headers({ 'x-request-id': 'req_test-123' }) };
    }
  });
  assert.equal(endpoint, 'https://openrouter.ai/api/v1/key');
  assert.equal(method, 'GET');
  assert.equal(authorizationPresent, true);
  assert.equal(result.category, 'credential_accepted');
  assert.deepEqual(Object.keys(result).sort(), ['category', 'credentialPresent', 'credentialVariable', 'endpointHost', 'httpStatus', 'provider', 'requestId'].sort());
  assert.equal(JSON.stringify(result).includes('test-only-not-a-real-secret'), false);
});

test('OpenRouter key diagnostic distinguishes rejected credentials and hides response bodies', async () => {
  const result = await checkOpenRouterKey({
    apiKey: 'test-only-not-a-real-secret',
    fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({ error: 'sensitive body' }) })
  });
  assert.equal(result.httpStatus, 401);
  assert.equal(result.category, 'credential_rejected');
  assert.equal(JSON.stringify(result).includes('sensitive body'), false);
});

test('OpenRouter key diagnostic reports network failures without error details', async () => {
  const result = await checkOpenRouterKey({ apiKey: 'test-only-not-a-real-secret', fetchImpl: async () => { throw new Error('sensitive network details'); } });
  assert.equal(result.category, 'network_error');
  assert.equal(result.httpStatus, null);
  assert.equal(JSON.stringify(result).includes('sensitive network details'), false);
});
