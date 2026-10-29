import { pathToFileURL } from 'node:url';
import path from 'node:path';

const endpoint = 'https://openrouter.ai/api/v1/key';

export async function checkOpenRouterKey({ apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const result = {
    provider: 'openrouter',
    endpointHost: new URL(endpoint).host,
    credentialVariable: 'OPENROUTER_API_KEY',
    credentialPresent: typeof apiKey === 'string' && apiKey.trim().length > 0,
    httpStatus: null,
    category: 'credential_missing',
    requestId: null
  };
  if (!result.credentialPresent) return result;

  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    result.httpStatus = response.status;
    result.category = response.ok ? 'credential_accepted'
      : response.status === 401 ? 'credential_rejected'
        : response.status === 403 ? 'access_denied'
          : response.status === 429 ? 'rate_limited'
            : response.status >= 500 ? 'provider_error' : 'request_rejected';
    const candidate = response.headers?.get?.('x-request-id') || response.headers?.get?.('x-openrouter-request-id');
    result.requestId = typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : null;
    return result;
  } catch (error) {
    result.category = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'network_timeout' : 'network_error';
    return result;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (process.env.RUN_AI_DIAGNOSTICS !== 'true') {
    console.log('Skipped: set RUN_AI_DIAGNOSTICS=true to explicitly check the OpenRouter key endpoint.');
  } else {
    const result = await checkOpenRouterKey();
    console.log(JSON.stringify(result));
    if (result.category !== 'credential_accepted') process.exitCode = 1;
  }
}
