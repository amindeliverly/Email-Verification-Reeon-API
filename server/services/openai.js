// =============================================================================
//  openai.js - shared OpenAI (CHATGPT_API_KEY) access for the GPT-powered tools
//  (Company Name Cleaner, Decision Maker AI Prioritizer)
// =============================================================================
const config = require('../config');
const { getSetting } = require('../db');

const NO_KEY_MESSAGE = 'API key not found. Please set CHATGPT_API_KEY in Admin → API Keys & Settings.';

/** The key/model saved in Admin → API Keys & Settings, falling back to .env. */
function getCredentials() {
  return {
    apiKey: getSetting('openai_api_key', '') || config.openai.defaultKey,
    model: getSetting('openai_model', '') || config.openai.defaultModel
  };
}

async function chat(systemPrompt, userPrompt, apiKey, model) {
  const res = await fetch(`${config.openai.apiBase}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    throw new Error('GPT API Error: ' + msg);
  }
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
}

module.exports = { getCredentials, chat, NO_KEY_MESSAGE };
