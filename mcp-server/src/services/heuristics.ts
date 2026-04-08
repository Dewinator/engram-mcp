/**
 * Heuristic encoding scorer.
 *
 * When openClaw calls `remember` without explicit importance/valence/arousal,
 * we estimate them from textual signals. This is intentionally cheap (regex,
 * no LLM) — the goal is to get the cognitive model out of its default-0.5
 * equilibrium so the salience/decay machinery actually does work.
 *
 * Signals are deliberately conservative: a normal sentence stays near defaults,
 * only marked-up content (deadlines, exclamations, emotional words, dates,
 * numbers) moves the dials.
 */

export interface EncodingSignals {
  importance: number; // 0..1
  valence: number; // -1..1
  arousal: number; // 0..1
}

// German has heavy inflection ("kritischer", "wichtige") so we use stem matching
// without trailing word boundaries. False positives are acceptable in v1.
const KW_IMPORTANT =
  /(wichtig|kritisch|essentiell|essenziell|immer\b|niemals|nie\b|deadline|termin|frist|geheim|passwort|merk dir|nicht vergessen|denk dran|achtung|warnung|geburtstag|jahrestag|adresse|telefon|important|critical|never|always|remember|secret|password|birthday)/i;

const KW_POSITIVE =
  /(gut\b|toll|super|liebe|mag\b|freude|gelungen|erfolg|perfekt|großartig|love|great|happy|awesome|thanks?|danke|grateful)/i;

const KW_NEGATIVE =
  /(schlecht|hass|fehler|problem|bug|kaputt|schlimm|wütend|traurig|frustriert|mist\b|hate|broken|terrible|awful|angry|sad\b|annoying|frustrated|wrong)/i;

const KW_INTENSE =
  /(sehr\b|extrem|riesig|enorm|völlig|absolut|unbedingt|sofort|dringend|asap|urgent|extremely|absolutely|immediately)/i;

const RE_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/;
const RE_NUMBER = /\b\d+[€$%]|\b\d{3,}\b/;
const RE_CAPS = /\b[A-ZÄÖÜ]{3,}\b/;

export function scoreEncoding(text: string): EncodingSignals {
  const t = text.trim();
  if (!t) return { importance: 0.5, valence: 0, arousal: 0 };

  // -- Importance ------------------------------------------------------------
  let importance = 0.5;
  if (KW_IMPORTANT.test(t)) importance += 0.25;
  if (RE_DATE.test(t)) importance += 0.10;
  if (RE_NUMBER.test(t)) importance += 0.05;
  if (RE_CAPS.test(t)) importance += 0.10;
  if (t.length > 200) importance += 0.05;
  if (t.length > 500) importance += 0.05;

  // -- Valence ---------------------------------------------------------------
  let valence = 0;
  if (KW_POSITIVE.test(t)) valence += 0.4;
  if (KW_NEGATIVE.test(t)) valence -= 0.4;

  // -- Arousal ---------------------------------------------------------------
  let arousal = 0;
  const exclamations = (t.match(/!/g) ?? []).length;
  arousal += Math.min(exclamations * 0.15, 0.4);
  if (KW_INTENSE.test(t)) arousal += 0.3;
  if (RE_CAPS.test(t)) arousal += 0.2;
  // Strong negative emotion is itself arousing
  if (KW_NEGATIVE.test(t)) arousal += 0.15;

  return {
    importance: clamp(importance, 0, 1),
    valence: clamp(valence, -1, 1),
    arousal: clamp(arousal, 0, 1),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
