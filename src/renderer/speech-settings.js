/* Cloud controls kept separate from the local voice picker. Credentials never
 * enter config JSON; each provider has its own secure-store alias. */
(() => {
  const tts = {
    elevenlabs: { label: 'ElevenLabs', model: 'eleven_v4_turbo', voice: 'JBFqnCBsd6RMkjVDRZzb', hint: 'Default: Eleven v4 Turbo dialogue streaming; George is the recommended British voice. V4 has no speed control. PCM and voice access depend on your account. Text is sent to api.elevenlabs.io. George is a legacy default voice scheduled to retire on December 31, 2026; choose a replacement before then.' },
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
    el('cfg-tts-cloud-model').oninput = null;
    el('cfg-tts-speed').title = '';
    el('tts-expressive-row').hidden = true;
    el('tts-director-row').hidden = true;
    if (!meta) return;
    const updateSpeed = () => {
      const model = el('cfg-tts-cloud-model').value;
      const v4 = engine === 'elevenlabs' && /^eleven_v4(?:_|$)/.test(model);
      el('cfg-tts-speed').disabled = v4;
      el('cfg-tts-speed').title = v4 ? 'Eleven v4 does not support speed control' : '';
      const tagsModel = window.AriaAudio.audioTagsActive(engine, model.trim(), true);
      el('tts-expressive-row').hidden = !tagsModel;
      el('tts-director-row').hidden = !tagsModel || !el('cfg-tts-expressive').checked;
      el('tts-director-key-row').hidden = el('cfg-tts-director').value !== 'jev';
    };
    el('cfg-tts-expressive').onchange = updateSpeed;
    el('cfg-tts-director').onchange = updateSpeed;
    el('cfg-tts-cloud-model').oninput = updateSpeed;
    el('tts-key-label').textContent = `${meta.label} API key`;
    el('cfg-tts-engine-hint').textContent = `${meta.hint} Your own key and account quota are required; speed is clamped to the provider’s range. Local voices remain available. No automatic upload to another provider.`;
    el('tts-cloud-voice-row').hidden = engine === 'deepgram';
    el('cfg-tts-speed').disabled = false;
    el('cfg-tts-cloud-model').value = meta.model;
    el('cfg-tts-cloud-voice').value = meta.voice;
    const [model, voice, saved, expressive, director, directorKey] = await Promise.all([
      aria.config.get(`tts.cloudModels.${engine}`), aria.config.get(`tts.cloudVoices.${engine}`), aria.secure.get(`tts-${engine}-api-key`).catch(() => null),
      aria.config.get('tts.expressive'), aria.config.get('tts.toneDirector'), aria.secure.get('jev-tone-api-key').catch(() => null),
    ]);
    if (version !== ttsVersion) return;
    el('cfg-tts-expressive').checked = expressive !== false;
    el('cfg-tts-director').value = director === 'jev' ? 'jev' : 'model';
    el('cfg-tts-director-key').value = '';
    el('cfg-tts-director-key').placeholder = directorKey ? 'Key saved — leave blank to keep' : 'Enter a Jev key';
    el('cfg-tts-cloud-model').value = edits[engine]?.model ?? model ?? meta.model;
    el('cfg-tts-cloud-voice').value = edits[engine]?.voice ?? voice ?? meta.voice;
    updateSpeed();
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
    const directorOn = engine === 'elevenlabs' && el('cfg-tts-director').value === 'jev' && !el('tts-director-row').hidden;
    const directorKey = el('cfg-tts-director-key').value.trim();
    if (directorOn && !directorKey && !await aria.secure.get('jev-tone-api-key').catch(() => null)) throw new Error('Enter a Jev API key to use Jev as the delivery director.');
    if (directorKey) {
      await aria.secure.set('jev-tone-api-key', directorKey);
      el('cfg-tts-director-key').value = ''; el('cfg-tts-director-key').placeholder = 'Key saved — leave blank to keep';
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
    if (engine === 'elevenlabs') {
      await aria.config.set('tts.expressive', el('cfg-tts-expressive').checked);
      await aria.config.set('tts.toneDirector', el('cfg-tts-director').value === 'jev' ? 'jev' : 'model');
    }
  }
  window.AriaSpeechSettings = { tts, updateStt, updateTts, validateAndSaveKeys, saveTts };
})();
