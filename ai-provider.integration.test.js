import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService } from './ai-service.js';
import { checkOpenRouterKey } from './openrouter-diagnostics.js';

const providerName = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const keyName = providerName === 'openrouter' ? 'OPENROUTER_API_KEY' : providerName === 'openai' ? 'OPENAI_API_KEY' : null;
const apiKey = keyName ? process.env[keyName] : undefined;
const optedIn = process.env.RUN_AI_INTEGRATION === 'true';
const enabled = process.env.AI_ENABLED !== 'false';
const skipReason = !optedIn ? 'Set RUN_AI_INTEGRATION=true to authorize real provider calls.'
  : !keyName ? 'AI_PROVIDER must be openai or openrouter.'
    : !apiKey?.trim() ? `${keyName} is not configured.`
      : !enabled ? 'AI_ENABLED=false disables provider calls.' : false;

async function safely(operation) {
  try { return await operation(); }
  catch (error) {
    const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
    throw new Error(`Provider request failed${status}; provider details, credentials, and request content were suppressed.`);
  }
}

test(`real ${providerName} inference validates every Whispr AI operation with synthetic data`, { skip: skipReason, timeout: 180_000 }, async (t) => {
  // No mock client is injected: this uses the configured provider's production SDK path and model.
  const ai = createAIService();
  assert.equal(ai.configured, true, 'configured SDK client should be available');

  if (providerName === 'openrouter') {
    const diagnostic = await checkOpenRouterKey({ apiKey });
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
    const result = await safely(() => ai.smartReplies({ conversationType: 'direct', currentUser: 'Casey', history }));
    assert.ok(Array.isArray(result.replies) && result.replies.length <= 3);
  });

  await t.test('scam analysis structured schema', async () => {
    const result = await safely(() => ai.scamAnalysis({ target: { sender: 'Synthetic Sender', text: 'Synthetic security test: reply with your sample password at https://example.invalid to avoid a fictional account hold.' }, history: [] }));
    assert.ok(Number.isInteger(result.riskScore) && result.riskScore >= 0 && result.riskScore <= 100);
    assert.equal(typeof result.uncertain, 'boolean');
    assert.ok(Array.isArray(result.categories) && Array.isArray(result.evidence) && Array.isArray(result.nextSteps));
  });

  await t.test('conversation summary structured schema', async () => {
    const result = await safely(() => ai.summary({ conversationType: 'direct', messages: history, suppliedMessageCount: history.length, contextMayBeIncomplete: false }));
    for (const field of ['topics', 'decisions', 'openQuestions', 'tasks', 'deadlines', 'keyPoints']) assert.ok(Array.isArray(result[field]), `summary.${field} should be an array`);
  });

  await t.test('translation', async () => {
    const result = await safely(() => ai.translate('The sample meeting starts at noon.', 'Spanish'));
    assert.ok(result.trim().length > 0);
  });

  await t.test('draft rewriting', async () => {
    const result = await safely(() => ai.rewrite('Send me the sample checklist today.', 'polite'));
    assert.ok(result.trim().length > 0);
  });

  await t.test('action extraction structured schema', async () => {
    const result = await safely(() => ai.actions({ messages: history, contextMayBeIncomplete: false }));
    assert.ok(Array.isArray(result.actions));
  });

  await t.test('AI-assisted search returns only supplied candidate IDs', async () => {
    const candidates = [
      { id: 'synthetic-1', conversation: 'Sample planning', sender: 'Morgan', timestamp: history[0].createdAt, text: history[0].text },
      { id: 'synthetic-2', conversation: 'Sample planning', sender: 'Casey', timestamp: history[1].createdAt, text: history[1].text }
    ];
    const result = await safely(() => ai.search('What was Casey going to review?', candidates));
    assert.ok(Array.isArray(result) && result.every((id) => candidates.some((candidate) => candidate.id === id)));
  });
});
