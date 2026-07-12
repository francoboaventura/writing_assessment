/**
 * Togethere — Writing Assessment API (Cloudflare Worker)
 *
 * POST /transcribe  { image }                                → { text }
 * POST /assess      { task_part, task_prompt, text, student } → resultado do motor (ver motor/prompt_a2.md)
 *
 * A transcrição é um passo separado de propósito: o aluno confere o texto do OCR
 * antes da avaliação, para que erro de leitura não vire erro de escrita na nota.
 *
 * Segredo: ANTHROPIC_API_KEY (wrangler secret put ANTHROPIC_API_KEY)
 */

import SYSTEM_PROMPT_A2 from "../../motor/prompt_a2.md";

const MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MIN_WORDS = { part6_email: 25, part7_story: 35 };

export default {
  async fetch(request, env) {
    const origin = cors(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: origin });
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, origin);

    const path = new URL(request.url).pathname.replace(/\/$/, "");

    try {
      const body = await request.json();
      if (path === "/transcribe") return json(await transcribe(body, env), 200, origin);
      if (path === "/assess" || path === "") return json(await assess(body, env), 200, origin);
      return json({ error: "Rota desconhecida. Use /transcribe ou /assess." }, 404, origin);
    } catch (err) {
      return json({ error: err.message }, err.status || 500, origin);
    }
  }
};

/* ── Passo 1: OCR ─────────────────────────────────────────────────────────── */

async function transcribe({ image }, env) {
  if (!image) throw bad("Envie a imagem da redação em 'image' (data URL).");

  const m = /^data:(image\/[a-z+]+);base64,(.+)$/is.exec(image.trim());
  if (!m) throw bad("Formato de imagem inválido. Esperado data URL base64.");
  const [, media_type, data] = m;

  const out = await claude(env, {
    max_tokens: 2000,
    temperature: 0,
    system:
      "You transcribe handwritten English learner writing, exactly as written. " +
      "Preserve every spelling mistake, grammar error, capitalisation and punctuation exactly as the learner wrote it. " +
      "Do NOT correct anything — the assessment depends on seeing the original errors. " +
      "Keep line breaks. If a word is genuinely illegible, write [?]. " +
      "Return only the transcription, with no commentary.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type, data } },
        { type: "text", text: "Transcribe this learner's writing exactly as written." }
      ]
    }]
  });

  return { text: textOf(out).trim() };
}

/* ── Passo 2: avaliação ───────────────────────────────────────────────────── */

async function assess({ task_part, task_prompt, text, student }, env) {
  if (!MIN_WORDS[task_part]) throw bad("task_part deve ser 'part6_email' ou 'part7_story'.");
  if (!task_prompt?.trim()) throw bad("Envie o enunciado da tarefa em 'task_prompt'.");
  if (!text?.trim()) throw bad("Envie o texto do aluno em 'text'.");

  const out = await claude(env, {
    max_tokens: 2000,
    temperature: 0, // o motor é calibrado em temperatura 0 — não mexa sem rodar test_concordancia.py
    system: SYSTEM_PROMPT_A2,
    messages: [{
      role: "user",
      content:
        `TASK TYPE: ${task_part}\n` +
        `TASK PROMPT (what the learner was asked to do):\n${task_prompt.trim()}\n\n` +
        `LEARNER'S TEXT (transcribed as written, errors preserved):\n${text.trim()}`
    }],
    // Força o JSON do contrato: o modelo continua a partir da chave de abertura.
    // Ver "Output format" em motor/prompt_a2.md.
    stop_sequences: []
  });

  const result = parseJson(textOf(out));

  // O motor conta as palavras, mas conferimos aqui — é aritmética, não julgamento.
  result.word_count = text.trim().split(/\s+/).filter(Boolean).length;
  result.min_words = MIN_WORDS[task_part];
  result.meets_word_minimum = result.word_count >= result.min_words;
  result.needs_teacher_review = true; // sempre true durante o piloto
  result.engine_version = "0.1";
  result.assessed_at = new Date().toISOString();
  if (student) result.student = student;

  return result;
}

/* ── Anthropic ────────────────────────────────────────────────────────────── */

async function claude(env, payload) {
  if (!env.ANTHROPIC_API_KEY) throw bad("ANTHROPIC_API_KEY não configurada no Worker.", 500);

  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({ model: MODEL, ...payload })
  });

  if (!r.ok) throw bad(`Anthropic ${r.status}: ${await r.text()}`, 502);
  return r.json();
}

const textOf = (res) => (res.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");

function parseJson(raw) {
  // O prompt pede JSON puro, mas cercas de markdown acontecem. Toleramos.
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    if (s === -1 || e === -1) throw bad("O modelo não devolveu JSON válido.", 502);
    return JSON.parse(clean.slice(s, e + 1));
  }
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

function cors(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map(s => s.trim());
  const origin = request.headers.get("Origin") ?? "";
  const ok = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}
