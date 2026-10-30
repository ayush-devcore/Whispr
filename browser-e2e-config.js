const providerSettings = {
  gemini: { credentialVariable: 'GEMINI_API_KEY', defaultModel: 'gemini-3.5-flash-lite' },
  openrouter: { credentialVariable: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-6-luna' },
  openai: { credentialVariable: 'OPENAI_API_KEY', defaultModel: 'gpt-6-luna' }
};

export function getBrowserE2EConfig(env = process.env) {
  const browserOptedIn = env.RUN_BROWSER_E2E === 'true';
  const aiRequested = env.RUN_BROWSER_AI_E2E === 'true';
  const aiProvider = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const provider = providerSettings[aiProvider];
  const aiCredentialVariable = provider?.credentialVariable || null;
  const aiCredentialPresent = !!env[aiCredentialVariable]?.trim();

  return {
    browserOptedIn,
    browserSkipReason: browserOptedIn ? false : 'Set RUN_BROWSER_E2E=true to launch the isolated synthetic-user browser journey.',
    aiRequested,
    aiProvider,
    aiCredentialVariable,
    aiBrowserOptIn: aiRequested && !!provider && aiCredentialPresent,
    aiSkipReason: !aiRequested ? 'Set RUN_BROWSER_AI_E2E=true in addition to RUN_BROWSER_E2E=true to authorize real provider calls.'
      : !provider ? 'RUN_BROWSER_AI_E2E=true requires AI_PROVIDER=gemini, AI_PROVIDER=openrouter, or AI_PROVIDER=openai.'
        : !aiCredentialPresent ? `Browser AI requires ${aiCredentialVariable} for the selected ${aiProvider} provider.` : false,
    aiModel: env.AI_MODEL || provider?.defaultModel || null
  };
}
