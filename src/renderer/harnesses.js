// Agent-harness presets. ARIA routes your voice to an agent harness over an
// OpenAI-compatible /chat/completions endpoint. Harnesses vary in how they
// serve that endpoint, so the URL stays editable — each preset just pre-fills a
// sensible default and a setup note. Loaded as a classic script in the renderer
// (sets window.AriaHarnesses) and requireable in Node for tests.

(function (root) {
  // kind 'agent' = a named agent harness (editable endpoint + note).
  // kind 'custom' = bring-your-own endpoint.
  const HARNESSES = [
    {
      id: 'claude-code', name: 'Claude Code', kind: 'agent',
      endpoint: 'http://localhost:8080/v1/chat/completions',
      defaultModel: 'claude-sonnet-4-6', keyHint: '',
      note: 'Expose Claude Code via an OpenAI-compatible bridge, then set its URL here.',
    },
    {
      id: 'codex', name: 'Codex', kind: 'agent',
      endpoint: 'http://localhost:1455/v1/chat/completions',
      defaultModel: 'gpt-5-codex', keyHint: '',
      note: 'Run Codex with its local server and point ARIA at it.',
    },
    {
      id: 'hermes', name: 'Hermes Agent', kind: 'agent',
      endpoint: 'http://localhost:8642/v1/chat/completions',
      defaultModel: 'minimax-m3', keyHint: 'gateway key', detect: true,
      note: 'Hermes serves its OpenAI-compatible gateway on port 8642 (not 8000). '
        + 'ARIA can auto-detect the gateway key from ~/.hermes/.env — no need to find it yourself.',
    },
    {
      id: 'openclaw', name: 'OpenClaw', kind: 'agent',
      endpoint: 'http://localhost:3000/v1/chat/completions',
      defaultModel: 'default', keyHint: '', detect: true,
      note: 'Point ARIA at your OpenClaw server endpoint — ARIA tries to auto-detect its key.',
    },
    {
      id: 'goose', name: 'Goose', kind: 'agent',
      endpoint: 'http://localhost:3001/v1/chat/completions',
      defaultModel: 'default', keyHint: '',
      note: 'Run Goose in server mode and set its endpoint.',
    },
    {
      id: 'aider', name: 'Aider', kind: 'agent',
      endpoint: 'http://localhost:5000/v1/chat/completions',
      defaultModel: 'default', keyHint: '',
      note: 'Expose Aider over an OpenAI-compatible endpoint.',
    },
    {
      id: 'custom', name: 'Custom (any OpenAI-compatible endpoint)', kind: 'custom',
      endpoint: '', defaultModel: '', keyHint: 'optional',
      note: 'Works with any OpenAI-compatible /chat/completions server.',
    },
  ];

  function byId(id) {
    return HARNESSES.find((h) => h.id === id) || null;
  }

  // Reverse-lookup from a stored endpoint, so the dropdown reflects config.
  function fromEndpoint(endpoint) {
    if (!endpoint) return null;
    const match = HARNESSES.find((h) => h.endpoint && h.endpoint === endpoint);
    return match || byId('custom');
  }

  // Conversational-LLM provider presets (OpenAI-compatible). Picking one fills
  // the endpoint + a default model so users don't have to know the URL.
  const PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', defaultModel: 'deepseek-chat', keyHint: 'sk-...' },
    { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4o-mini', keyHint: 'sk-...' },
    { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'openai/gpt-4o-mini', keyHint: 'sk-or-...' },
    { id: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', defaultModel: 'llama-3.3-70b-versatile', keyHint: 'gsk_...' },
    { id: 'together', name: 'Together AI', endpoint: 'https://api.together.xyz/v1/chat/completions', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyHint: '...' },
    { id: 'mistral', name: 'Mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', defaultModel: 'mistral-small-latest', keyHint: '...' },
    // Fully-local, OpenAI-compatible servers. No API key required (local servers
    // ignore it); leave the key blank. `local: true` marks them so the UI can
    // show the key as optional and skip remote-only hints.
    { id: 'ollama', name: 'Ollama (local)', endpoint: 'http://localhost:11434/v1/chat/completions', defaultModel: 'llama3.2', keyHint: '', local: true },
    { id: 'lmstudio', name: 'LM Studio (local)', endpoint: 'http://localhost:1234/v1/chat/completions', defaultModel: 'local-model', keyHint: '', local: true },
    { id: 'vllm', name: 'vLLM (local)', endpoint: 'http://localhost:8000/v1/chat/completions', defaultModel: '', keyHint: '', local: true },
    { id: 'custom', name: 'Custom (enter URL)', endpoint: '', defaultModel: '', keyHint: '' },
  ];
  function providerById(id) { return PROVIDERS.find((p) => p.id === id) || null; }
  function providerFromEndpoint(ep) {
    if (!ep) return null;
    return PROVIDERS.find((p) => p.endpoint && p.endpoint === ep) || providerById('custom');
  }

  const api = { HARNESSES, byId, fromEndpoint, PROVIDERS, providerById, providerFromEndpoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AriaHarnesses = api;
})(typeof self !== 'undefined' ? self : this);
