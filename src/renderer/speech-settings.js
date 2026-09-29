/* Cloud controls kept separate from the local voice picker. Credentials never
 * enter config JSON; each provider has its own secure-store alias. */
(() => {
  const tts = {
    elevenlabs: { label: 'ElevenLabs', model: 'eleven_flash_v2_5', voice: 'JBFqnCBsd6RMkjVDRZzb', hint: 'Flash synthesis; PCM access depends on your account. Text is sent to api.elevenlabs.io.' },
    cartesia: { label: 'Cartesia', model: 'sonic-3.6', voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', hint: 'Sonic streaming synthesis. Text is sent to api.cartesia.ai.' },
    openai: { label: 'OpenAI', model: 'gpt-4o-mini-tts', voice: 'onyx', hint: 'AI-generated speech with built-in voices. Text is sent to api.openai.com.' },
    deepgram: { label: 'Deepgram', model: 'aura-2-odysseus-en', voice: '', hint: 'Aura synthesis; the model ID selects the voice. Text is sent to api.deepgram.com. Speaking speed is limited to 0.7–1.5×.' },
  };
  const stt = {
    groq: { label: 'Groq', alias: 'stt-api-key', hint: 'Audio and vocabulary are sent to api.groq.com. Quotas apply; failures fall back locally.' },
    deepgram: { label: 'Deepgram', alias: 'stt-deepgram-api-key', hint: 'Nova-3: final utterance audio is sent to api.deepgram.com. Vocabulary applies to local fallback only. Failures fall back locally.' },
    assemblyai: { label: 'AssemblyAI', alias: 'stt-assemblyai-api-key', hint: 'Universal-3.5 Pro: final audio is uploaded to api.assemblyai.com, then polled for completion. Batch results must arrive within 5 seconds or ARIA falls back locally; the submitted cloud job may still finish and be billed. Vocabulary applies to local fallback only.' },
  };
  const el = id => document.getElementById(id);
  let sttVersion = 0, ttsVersion = 0;
  const edits = {};
  for (const id of ['cfg-tts-cloud-model', 'cfg-tts-cloud-voice']) {
    el(id).addEventListener('input', () => {
      const engine = el('cfg-tts-engine').value;
      edits[engine] = { model: el('cfg-tts-cloud-model').value, voice: el('cfg-tts-cloud-voice').value };
    });
  }
  async function updateStt(aria) {
    const version = ++sttVersion, provider = el('cfg-stt-provider').value, meta = stt[provider];
    el('stt-cloud-key-row').hidden = !meta;
    el('stt-groq-model-row').hidden = provider !== 'groq';
    el('stt-provider-hint').textContent = meta ? 'Cloud is opt-in; audio is uploaded only when an utterance ends.' : 'Local speech recognition; audio stays here.';
    el('stt-cloud-privacy').textContent = meta ? meta.hint : '';
    el('stt-key-label').textContent = meta ? `${meta.label} API key` : 'API key';
    el('cfg-stt-key').value = '';
    el('cfg-stt-key').placeholder = meta ? `Enter a key to enable ${meta.label}` : '';
    if (meta) {
      const saved = await aria.secure.get(meta.alias).catch(() => null);
      if (version === sttVersion && saved) el('cfg-stt-key').placeholder = 'Key saved — leave blank to keep';
    }
  }
  async function updateTts(aria, engine) {
    const version = ++ttsVersion, meta = tts[engine];
    el('tts-cloud-row').hidden = !meta;
    el('tts-local-voice-row').hidden = !!meta;
    el('cfg-tts-key').value = '';
    el('cfg-tts-key').placeholder = meta ? `Enter a key to enable ${meta.label}` : '';
    if (!meta) return;
    el('tts-key-label').textContent = `${meta.label} API key`;
    el('cfg-tts-engine-hint').textContent = `${meta.hint} Your own key and account quota are required; speed is clamped to the provider’s range. Local voices remain available. No automatic upload to another provider.`;
    el('tts-cloud-voice-row').hidden = engine === 'deepgram';
    el('cfg-tts-speed').disabled = false;
    el('cfg-tts-cloud-model').value = meta.model;
    el('cfg-tts-cloud-voice').value = meta.voice;
    const [model, voice, saved] = await Promise.all([
      aria.config.get(`tts.cloudModels.${engine}`), aria.config.get(`tts.cloudVoices.${engine}`), aria.secure.get(`tts-${engine}-api-key`).catch(() => null),
    ]);
    if (version !== ttsVersion) return;
    el('cfg-tts-cloud-model').value = edits[engine]?.model ?? model ?? meta.model;
    el('cfg-tts-cloud-voice').value = edits[engine]?.voice ?? voice ?? meta.voice;
    if (saved) el('cfg-tts-key').placeholder = 'Key saved — leave blank to keep';
  }
  async function validateAndSaveKeys(aria) {
    const provider = el('cfg-stt-provider').value, engine = el('cfg-tts-engine').value;
    const aliases = [stt[provider]?.alias, tts[engine] ? `tts-${engine}-api-key` : null];
    const fields = [el('cfg-stt-key'), el('cfg-tts-key')];
    // Validate every provider first, before mutating any credential/config.
    for (let i = 0; i < aliases.length; i++) {
      if (aliases[i] && !fields[i].value.trim() && !await aria.secure.get(aliases[i])) throw new Error(`Enter a ${i === 0 ? provider : engine} API key before enabling cloud speech.`);
    }
    if (tts[engine]) {
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(el('cfg-tts-cloud-model').value.trim())) throw new Error('Enter a valid cloud TTS model ID.');
      if (engine !== 'deepgram' && !/^[a-zA-Z0-9_.-]{1,100}$/.test(el('cfg-tts-cloud-voice').value.trim())) throw new Error('Enter a valid cloud TTS voice ID.');
    }
    for (let i = 0; i < aliases.length; i++) {
      if (aliases[i] && fields[i].value.trim()) {
        await aria.secure.set(aliases[i], fields[i].value.trim());
        fields[i].value = ''; fields[i].placeholder = 'Key saved — leave blank to keep';
      }
    }
  }
  async function saveTts(aria, engine) {
    await aria.config.set(`tts.cloudModels.${engine}`, el('cfg-tts-cloud-model').value.trim());
    await aria.config.set(`tts.cloudVoices.${engine}`, el('cfg-tts-cloud-voice').value.trim());
  }
  window.AriaSpeechSettings = { tts, updateStt, updateTts, validateAndSaveKeys, saveTts };
})();
