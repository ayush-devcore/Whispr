const providerSettings = {
  gemini: {
    credentialVariable: 'GEMINI_API_KEY',
    endpointHost: 'generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.5-flash-lite'
  },
  openrouter: {
    credentialVariable: 'OPENROUTER_API_KEY',
    endpointHost: 'openrouter.ai',
    defaultModel: 'openai/gpt-6-luna'
  },
  openai: {
    credentialVariable: 'OPENAI_API_KEY',
    endpointHost: 'api.openai.com',
    defaultModel: 'gpt-6-luna'
  }
};

export function getAIIntegrationConfig(env = process.env) {
  const providerName = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const settings = providerSettings[providerName];
  const credentialVariable = settings?.credentialVariable || null;
  const apiKey = credentialVariable ? env[credentialVariable] : undefined;
  const optedIn = env.RUN_AI_INTEGRATION === 'true';
  const enabled = env.AI_ENABLED !== 'false';
  const skipReason = !optedIn ? 'Set RUN_AI_INTEGRATION=true to authorize real provider calls.'
    : !settings ? 'AI_PROVIDER must be gemini, openrouter, or openai.'
      : !apiKey?.trim() ? `AI_PROVIDER=${providerName} requires ${credentialVariable}.`
        : !enabled ? 'AI_ENABLED=false disables provider calls.' : false;

  return {
    providerName,
    credentialVariable,
    apiKey,
    endpointHost: settings?.endpointHost || null,
    model: env.AI_MODEL || settings?.defaultModel || null,
    optedIn,
    enabled,
    skipReason
  };
}

function getGemini400Message(providerMessage) {
  const message = typeof providerMessage === 'string' ? providerMessage : '';
  const unknownField = message.match(/unknown name\s+["'`]([A-Za-z][A-Za-z0-9_]*)["'`]/i)?.[1];
  if (unknownField) return `Gemini rejected unknown request field "${unknownField}".`;
  if (/schema.{0,80}(too many states|too complex|complexity)|too many states.{0,80}schema/i.test(message)) return 'Gemini rejected the structured-output schema as too complex.';
  if (/invalid json payload/i.test(message)) return 'Gemini rejected the request payload as invalid.';
  if (/schema/i.test(message)) return 'Gemini rejected the structured-output schema (HTTP 400).';
  return 'Gemini rejected the request as invalid (HTTP 400).';
}

function parseGeminiErrorBody(error) {
  if (typeof error?.message !== 'string' || error.message.length > 20_000) return null;
  try {
    const parsed = JSON.parse(error.message);
    return parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
  } catch { return null; }
}

function safeRequestId(error, body) {
  const headerId = error?.headers?.get?.('x-goog-request-id') || error?.headers?.get?.('x-request-id');
  const candidate = headerId || body?.requestId || body?.request_id;
  return typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : null;
}

export function providerFailureDiagnostic(error, providerName, operation = 'unknown') {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const body = providerName === 'gemini' ? parseGeminiErrorBody(error) : null;
  const candidateCode = body?.status || (typeof error?.code === 'string' ? error.code : null);
  const providerCode = typeof candidateCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidateCode) ? candidateCode : null;
  let message = 'Provider inference failed; provider details, credentials, and request content were suppressed.';

  if (providerName === 'gemini' && status === 400) message = getGemini400Message(body?.message);
  else if (providerName === 'openrouter' && status === 402) message = 'OpenRouter accepted the credential check but rejected inference with HTTP 402. Check account credits, spending limits, and model/provider availability; no successful inference was produced.';
  else if (providerName === 'gemini' && status === 429) message = 'Gemini rejected inference with HTTP 429. Check Gemini API quota, rate limits, and billing for the selected project; no successful inference was produced.';
  else if (providerName === 'gemini' && (status === 401 || status === 403)) message = `Gemini rejected authentication or API access with HTTP ${status}; verify GEMINI_API_KEY, its API restrictions, and project access.`;
  else if (providerName === 'gemini' && status === 404) message = 'Gemini could not find the configured model (HTTP 404); verify AI_MODEL is available to this project.';
  else if (status === 401) message = `Provider rejected inference with HTTP 401; verify the configured ${providerName} credential.`;
  else if (status === 403) message = `Provider denied inference with HTTP 403; verify account and model access for ${providerName}.`;
  else if (status === 429) message = `Provider rate limited inference with HTTP 429; retry after the provider limit resets.`;
  else if (status) message = `Provider inference failed with HTTP ${status}; provider details, credentials, and request content were suppressed.`;

  return {
    provider: providerName,
    operation: /^[A-Za-z0-9_. -]{1,80}$/.test(operation) ? operation : 'unknown',
    httpStatus: status,
    providerCode,
    message,
    requestId: providerName === 'gemini' ? safeRequestId(error, body) : null
  };
}

export function safeProviderFailure(error, providerName) {
  const diagnostic = providerFailureDiagnostic(error, providerName);
  return diagnostic.httpStatus === null ? diagnostic.message : `${diagnostic.message} (HTTP ${diagnostic.httpStatus}${diagnostic.providerCode ? ` ${diagnostic.providerCode}` : ''}).`;
}
