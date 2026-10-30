import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService, createProviderClient } from './ai-service.js';
import { checkOpenRouterKey } from './openrouter-diagnostics.js';
import { getAIIntegrationConfig, providerFailureDiagnostic } from './ai-provider.integration-config.js';

const config = getAIIntegrationConfig();

async function safely(operationName, operation) {
  try { return await operation(); }
  catch (error) { throw new Error(JSON.stringify(providerFailureDiagnostic(error, config.providerName, operationName))); }
}

test(`real ${config.providerName} inference validates every Whispr AI operation with synthetic data`, { skip: config.skipReason, timeout: 180_000 }, async (t) => {
  // No mock client is injected: this uses the configured provider's production SDK path and model.
  const ai = createAIService({ providerName: config.providerName, apiKey: config.apiKey, model: config.model, enabled: config.enabled });
  assert.equal(ai.configured, true, 'configured SDK client should be available');
  assert.equal(ai.diagnostics.endpointHost, config.endpointHost, 'integration provider endpoint does not match AI_PROVIDER');
  assert.equal(ai.model, config.model, 'integration model does not match AI_MODEL');

  if (config.providerName === 'gemini') {
    const gemini = createProviderClient({ providerName: 'gemini', apiKey: config.apiKey, timeoutMs: 20_000 });
    let textOnlyPassed = false;
    await t.test('Gemini text-only baseline', async () => {
      const response = await safely('text-only baseline', () => gemini.models.generateContent({
        model: config.model,
        contents: 'Reply with the single word READY.',
        config: { maxOutputTokens: 16, httpOptions: { timeout: 20_000, retryOptions: { attempts: 1 } } }
      }));
      assert.ok(typeof response.text === 'string' && response.text.trim().length > 0, 'Gemini returned no text for the baseline request.');
      textOnlyPassed = true;
    });
    if (!textOnlyPassed) { t.diagnostic('Structured-output and Whispr operation probes were not sent because the text-only baseline failed.'); return; }

    let minimalJsonPassed = false;
    await t.test('Gemini minimal JSON schema baseline', async () => {
      const response = await safely('minimal JSON schema baseline', () => gemini.models.generateContent({
        model: config.model,
        contents: 'Return an object where ok is true.',
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          maxOutputTokens: 24,
          httpOptions: { timeout: 20_000, retryOptions: { attempts: 1 } }
        }
      }));
      let parsed;
      try { parsed = JSON.parse(response.text); } catch { assert.fail('Gemini minimal JSON baseline did not return valid JSON.'); }
      assert.equal(parsed.ok, true, 'Gemini minimal JSON baseline returned the wrong shape/value.');
      minimalJsonPassed = true;
    });
    if (!minimalJsonPassed) { t.diagnostic('Whispr schema probes were not sent because the minimal JSON schema baseline failed.'); return; }
  }

  if (config.providerName === 'openrouter') {
    const diagnostic = await checkOpenRouterKey({ apiKey: config.apiKey });
    await t.test('OpenRouter key endpoint accepts the configured credential', () => {
      assert.equal(diagnostic.category, 'credential_accepted', diagnostic.httpStatus
        ? `OpenRouter key check was rejected with HTTP ${diagnostic.httpStatus}.`
        : `OpenRouter key check failed at the network layer (${diagnostic.category}).`);
    });
    if (diagnostic.category !== 'credential_accepted') return;
  }

  const history = [
    { id: 'synthetic-1', sender: 'Morgan', mine: false, text: 'Can you review the sample launch checklist by Friday?', createdAt: '2026-10-20T10:00:00.000Z' },
    { id: 'synthetic-2', sender: 'Casey', mine: true, text: 'Yes, I can review it and send notes before Friday.', createdAt: '2026-10-20T10:01:00.000Z' },
    { id: 'synthetic-3', sender: 'Morgan', mine: false, text: 'Thanks. Please focus on the onboarding steps.', createdAt: '2026-10-20T10:02:00.000Z' }
  ];

  await t.test('smart replies', async () => {
    const result = await safely('smart replies', () => ai.smartReplies({ conversationType: 'direct', currentUser: 'Casey', history }));
    assert.ok(Array.isArray(result.replies) && result.replies.length <= 3);
  });

  await t.test('scam analysis structured schema', async () => {
    const result = await safely('scam analysis', () => ai.scamAnalysis({ target: { sender: 'Synthetic Sender', text: 'Synthetic security test: reply with your sample password at https://example.invalid to avoid a fictional account hold.' }, history: [] }));
    assert.ok(Number.isInteger(result.riskScore) && result.riskScore >= 0 && result.riskScore <= 100);
    assert.equal(typeof result.uncertain, 'boolean');
    assert.ok(Array.isArray(result.categories) && Array.isArray(result.evidence) && Array.isArray(result.nextSteps));
  });

  await t.test('AI link safety analysis schema', async () => {
    const result = await safely('AI link safety analysis', () => ai.linkAnalysis({
      links: [{
        url: 'https://paypal-login.example/verify?token=%5Bredacted%5D',
        hostname: 'paypal-login.example',
        localScore: 69,
        localSeverity: 'high',
        localSignals: ['possible_brand_impersonation', 'sensitive_or_urgent_url_path'],
        reputationStatus: 'not_checked'
      }]
    }));
    assert.ok(Array.isArray(result.links) && result.links.length <= 5);
    for (const link of result.links) {
      assert.ok(Number.isInteger(link.riskScore) && link.riskScore >= 0 && link.riskScore <= 100);
      assert.ok(['low', 'medium', 'high', 'critical'].includes(link.severity));
      assert.equal(typeof link.uncertain, 'boolean');
    }
  });

  await t.test('conversation summary structured schema', async () => {
    const result = await safely('conversation summary', () => ai.summary({ conversationType: 'direct', messages: history, suppliedMessageCount: history.length, contextMayBeIncomplete: false }));
    for (const field of ['topics', 'decisions', 'openQuestions', 'tasks', 'deadlines', 'keyPoints']) assert.ok(Array.isArray(result[field]), `summary.${field} should be an array`);
  });

  await t.test('translation', async () => {
    const result = await safely('translation', () => ai.translate('The sample meeting starts at noon.', 'Spanish'));
    assert.ok(result.trim().length > 0);
  });

  await t.test('draft rewriting', async () => {
    const result = await safely('draft rewriting', () => ai.rewrite('Send me the sample checklist today.', 'polite'));
    assert.ok(result.trim().length > 0);
  });

  await t.test('action extraction structured schema', async () => {
    const result = await safely('action extraction', () => ai.actions({ messages: history, contextMayBeIncomplete: false }));
    assert.ok(Array.isArray(result.actions));
  });

  await t.test('AI-assisted search returns only supplied candidate IDs', async () => {
    const candidates = [
      { id: 'synthetic-1', conversation: 'Sample planning', sender: 'Morgan', timestamp: history[0].createdAt, text: history[0].text },
      { id: 'synthetic-2', conversation: 'Sample planning', sender: 'Casey', timestamp: history[1].createdAt, text: history[1].text }
    ];
    const result = await safely('AI-assisted search', () => ai.search('What was Casey going to review?', candidates));
    assert.ok(Array.isArray(result) && result.every((id) => candidates.some((candidate) => candidate.id === id)));
  });
});
