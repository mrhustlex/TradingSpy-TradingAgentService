const ORCHESTRATOR_LINE = /^(?:Backend received request\.\.\.|🧠\s*Thinking|🧠\s*THOUGHT:.*|⚡\s*ACTION:.*|👁️\s*OBSERVATION:.*|💬\s*FINAL ANSWER:.*|Response:\s*\d+\s*chars?)$/i;

const tryParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const formatActionPayload = (action, payload) => {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.response === 'string' && payload.response.trim()) return payload.response.trim();
  if (action === 'generate_strategy') {
    const target = typeof payload.target === 'string' ? payload.target.trim() : '';
    const description = typeof payload.description === 'string' ? payload.description.trim() : '';
    if (target && description) return `Generated strategy for **${target}**:\n\n${description}`;
    if (description) return description;
  }
  return '';
};

const parseActionEnvelope = (value) => {
  const match = value.trim().match(/^([a-z_][a-z0-9_]*)\s*:\s*(\{[\s\S]*\})$/i);
  if (!match) return '';
  const payload = tryParseJson(match[2]);
  if (!payload) return '';
  return formatActionPayload(match[1].toLowerCase(), payload);
};

export const normalizeAssistantResponseText = (rawContent) => {
  const raw = String(rawContent || '').trim();
  if (!raw) return '';

  const json = tryParseJson(raw);
  if (json && typeof json === 'object') {
    const fromJson = formatActionPayload('', json);
    if (fromJson) return fromJson;
  }

  const fromAction = parseActionEnvelope(raw);
  if (fromAction) return fromAction;

  const cleaned = raw
    .split('\n')
    .filter(line => !ORCHESTRATOR_LINE.test(line.trim()))
    .join('\n')
    .trim();

  if (!cleaned) return '';

  const cleanedAction = parseActionEnvelope(cleaned);
  if (cleanedAction) return cleanedAction;

  return cleaned;
};

