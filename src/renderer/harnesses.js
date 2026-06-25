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
      endpoint: 'http://localhost:8000/v1/chat/completions',
      defaultModel: 'hermes', keyHint: '',
      note: 'Start the Hermes agent server, then set its endpoint.',
    },
    {
      id: 'openclaw', name: 'OpenClaw', kind: 'agent',
      endpoint: 'http://localhost:3000/v1/chat/completions',
      defaultModel: 'default', keyHint: '',
      note: 'Point ARIA at your OpenClaw server endpoint.',
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

  const api = { HARNESSES, byId, fromEndpoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AriaHarnesses = api;
})(typeof self !== 'undefined' ? self : this);
