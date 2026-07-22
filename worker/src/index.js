/**
 * Togethere — Writing Assessment API (Cloudflare Worker)
 *
 * POST /transcribe  { image }                                        → { text }
 * POST /assess      { level, task_part, task_prompt, text, student } → resultado do motor
 *
 * A transcrição é um passo separado de propósito: o aluno confere o texto do OCR
 * antes da avaliação, para que erro de leitura não vire erro de escrita na nota.
 *
 * NÍVEIS
 *  Base (régua CEFR):      a2 (Cambridge A2 Key), b1, b2, c1  +  a1 (descritores Togethere)
 *  Trilhas Junior/Teens:
 *    a1plus_junior / a2plus_junior / b1plus_teens  → "+"= nível CEFR consolidado → usa a régua cheia
 *    a1_junior     / a2_junior     / b1_teens      → "meio caminho": mesma régua CEFR + CALIBRAÇÃO mais leve
 *  A calibração NÃO é um prompt novo: é um bloco anexado ao prompt do nível que abaixa a barra
 *  de aprovação para o ponto intermediário (estar "na metade" já passa).
 *
 * Para adicionar um nível: registre em LEVELS abaixo (e, se precisar de régua nova, crie o .md em motor/).
 *
 * Segredo: ANTHROPIC_API_KEY (wrangler secret put ANTHROPIC_API_KEY)
 */

import SYSTEM_PROMPT_A1 from "../motor/prompt_a1.md";
import SYSTEM_PROMPT_A2 from "../motor/prompt_a2.md";
import SYSTEM_PROMPT_B1 from "../motor/prompt_b1.md";
import SYSTEM_PROMPT_B2 from "../motor/prompt_b2.md";
import SYSTEM_PROMPT_C1 from "../motor/prompt_c1.md";

const MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const FORMATOS = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/* ── Tarefas aceitas por régua (task_part → mínimo de palavras) ───────────── */
const T_A1 = { short_message: 20, about_me: 20, free_text: 20 };
const T_A2 = { part6_email: 25, part7_story: 35, free_text: 25 };
const T_B1 = { part1_email: 100, part2_article: 100, part2_story: 100, free_text: 100 };
const T_B2 = { part1_essay: 140, part2_article: 140, part2_email: 140, part2_review: 140, part2_story: 140, free_text: 140 };
const T_C1 = { part1_essay: 220, part2_letter: 220, part2_proposal: 220, part2_report: 220, part2_review: 220, free_text: 220 };

/* ── Calibração "meio caminho" (anexada ao prompt do nível cheio) ─────────── */
const HALF = (alvo) => `---

CALIBRATION OVERRIDE — TOGETHERE "HALF LEVEL" (a caminho de ${alvo}).
This is a Togethere Junior/Teens learner who is roughly HALFWAY to CEFR ${alvo} and has NOT yet consolidated ${alvo}. Apply the assessment scale above, but recalibrate GENEROUSLY to this learner's stage:
- A text that shows the learner is genuinely on track toward ${alvo} — roughly half the range and control expected at full ${alvo} — MUST land in the PASS range (overall_band 3).
- A solid, on-track "halfway" performance is MERIT (4) or DISTINCTION (5) at this level.
- Reserve UNSATISFACTORY (overall_band 1-2) only for texts that show almost no progress toward ${alvo}.
- Do NOT hold the learner to the full ${alvo} standard, and do not penalise for range/complexity that only a consolidated ${alvo} learner would show.
- Set "cefr_result" to "On track to ${alvo}" when overall_band is 3 or higher, and "Below ${alvo} track" otherwise.
- Write "summary_pt" and "next_steps" as encouraging, concrete progress toward ${alvo}.
- Keep "needs_teacher_review": true.`;

const HALF_A1 = HALF("A1");
const HALF_A2 = HALF("A2");
const HALF_B1 = HALF("B1");

/* ── Registro de níveis ───────────────────────────────────────────────────── */
const LEVELS = {
  // genéricos (régua CEFR cheia)
  a1: { prompt: SYSTEM_PROMPT_A1, tasks: T_A1 },
  a2: { prompt: SYSTEM_PROMPT_A2, tasks: T_A2 },
  b1: { prompt: SYSTEM_PROMPT_B1, tasks: T_B1 },
  b2: { prompt: SYSTEM_PROMPT_B2, tasks: T_B2 },
  c1: { prompt: SYSTEM_PROMPT_C1, tasks: T_C1 },
  // trilha Junior/Teens — "+": CEFR consolidado (régua cheia)
  a1plus_junior: { prompt: SYSTEM_PROMPT_A1, tasks: T_A1 },
  a2plus_junior: { prompt: SYSTEM_PROMPT_A2, tasks: T_A2 },
  b1plus_teens:  { prompt: SYSTEM_PROMPT_B1, tasks: T_B1 },
  // trilha Junior/Teens — "meio caminho": régua cheia + calibração mais leve
  a1_junior: { prompt: SYSTEM_PROMPT_A1, tasks: T_A1, calibration: HALF_A1 },
  a2_junior: { prompt: SYSTEM_PROMPT_A2, tasks: T_A2, calibration: HALF_A2 },
  b1_teens:  { prompt: SYSTEM_PROMPT_B1, tasks: T_B1, calibration: HALF_B1 },
};

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

  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/is.exec(image.trim());
  if (!m) throw bad("Formato de imagem inválido. Esperado data URL base64.");
  const [, media_type, data] = m;

  if (!FORMATOS.includes(media_type.toLowerCase())) {
    throw bad(
      media_type.includes("hei")
        ? "HEIC não é aceito pela API. Converta para JPEG antes de enviar."
        : `Formato ${media_type} não suportado. Use JPEG, PNG, GIF ou WEBP.`
    );
  }

  if (data.length * 0.75 > 5 * 1024 * 1024)
    throw bad("Imagem acima de 5 MB. Reduza a foto antes de enviar.", 413);

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

async function assess({ level, task_part, task_prompt, text, student }, env) {
  const lvKey = String(level || "a2").toLowerCase();          // sem nível → A2 (compatibilidade)
  const lv = LEVELS[lvKey];
  if (!lv)
    throw bad(`Nível '${level}' ainda não disponível no motor. Disponíveis: ${Object.keys(LEVELS).join(", ")}.`);

  const min = lv.tasks[task_part];
  if (min == null)
    throw bad(`Tarefa '${task_part}' não é válida para o nível ${lvKey}. Válidas: ${Object.keys(lv.tasks).join(", ")}.`);

  if (!task_prompt?.trim()) throw bad("Envie o enunciado da tarefa em 'task_prompt'.");
  if (!text?.trim()) throw bad("Envie o texto do aluno em 'text'.");

  // Nível "meio caminho": régua cheia + bloco de calibração mais leve anexado.
  const system = lv.calibration ? (lv.prompt + "\n\n" + lv.calibration) : lv.prompt;

  const out = await claude(env, {
    max_tokens: 2000,
    temperature: 0, // calibrado em temperatura 0 — não mexa sem rodar o teste de concordância
    system,
    messages: [{
      role: "user",
      content:
        `LEVEL: ${lvKey}\n` +
        `TASK TYPE: ${task_part}\n` +
        `TASK PROMPT (what the learner was asked to do):\n${task_prompt.trim()}\n\n` +
        `LEARNER'S TEXT (transcribed as written, errors preserved):\n${text.trim()}`
    }],
    stop_sequences: []
  });

  const result = parseJson(textOf(out));

  result.word_count = text.trim().split(/\s+/).filter(Boolean).length;
  result.min_words = min;
  result.meets_word_minimum = result.word_count >= result.min_words;
  result.needs_teacher_review = true;
  result.engine_version = "0.3";
  result.assessed_at = new Date().toISOString();
  result.level = lvKey;
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
