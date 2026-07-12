/**
 * Togethere — Writing Assessment API (Cloudflare Worker)
 *
 * POST /levels                                                → registro de níveis e tarefas
 * POST /transcribe  { image }                                 → { text }
 * POST /assess      { level, task_part, task_prompt, text }   → resultado do motor
 *
 * A transcrição é um passo separado de propósito: o aluno confere o texto do OCR
 * antes da avaliação, para que erro de leitura não vire erro de escrita na nota.
 *
 * Segredo: ANTHROPIC_API_KEY (npx wrangler secret put ANTHROPIC_API_KEY)
 */

import PROMPT_A2 from "../../motor/prompt_a2.md";
import PROMPT_B1 from "../../motor/prompt_b1.md";
import PROMPT_B2 from "../../motor/prompt_b2.md";
import PROMPT_C1 from "../../motor/prompt_c1.md";
import LEVELS from "../../data/levels.json";

const MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const FORMATOS = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Um prompt por nível. Um nível sem prompt aqui não avalia — e é isso mesmo:
// avaliar C2 com a régua do C1 daria uma nota sem sentido.
const PROMPTS = { a2: PROMPT_A2, b1: PROMPT_B1, b2: PROMPT_B2, c1: PROMPT_C1 };

/**
 * Extrai o bloco SYSTEM PROMPT do .md — só ele vai para o modelo.
 * O resto do arquivo (template da mensagem, notas de implementação) é
 * documentação para nós, não instrução para o avaliador.
 *
 * O motor/test_concordancia.py faz exatamente esta mesma extração. Se as duas
 * divergirem, o prompt medido no teste deixa de ser o prompt que roda aqui —
 * e a calibração não vale mais nada.
 */
function systemPrompt(level) {
  const md = PROMPTS[level];
  const inicio = md.indexOf("## SYSTEM PROMPT");
  const fim = md.indexOf("## USER MESSAGE TEMPLATE");
  if (inicio === -1 || fim === -1) throw bad(`prompt_${level}.md sem os marcadores esperados.`, 500);
  return md.slice(inicio + "## SYSTEM PROMPT".length, fim).trim();
}

export default {
  async fetch(request, env) {
    const origin = cors(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: origin });

    const path = new URL(request.url).pathname.replace(/\/$/, "");

    // /levels responde a GET também — o frontend monta os seletores com isso.
    if (path === "/levels") return json(LEVELS, 200, origin);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, origin);

    try {
      const body = await request.json();
      if (path === "/transcribe") return json(await transcribe(body, env), 200, origin);
      if (path === "/assess" || path === "") return json(await assess(body, env), 200, origin);
      return json({ error: "Rota desconhecida. Use /levels, /transcribe ou /assess." }, 404, origin);
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

  // A API aceita só estes quatro. HEIC (foto de iPhone) é convertido para JPEG
  // no navegador antes de chegar aqui — ver reduzirParaJpeg() no index.html.
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
  const nivel = LEVELS.levels.find(l => l.id === level);
  if (!nivel) throw bad(`Nível '${level}' desconhecido.`);
  if (!nivel.enabled || !PROMPTS[level])
    throw bad(`O motor de ${nivel.label} ainda não existe. ${nivel.status ?? ""}`.trim(), 501);

  const tarefa = nivel.tasks.find(t => t.id === task_part);
  if (!tarefa) throw bad(`Tarefa '${task_part}' não existe em ${nivel.label}.`);
  if (!task_prompt?.trim()) throw bad("Envie o enunciado da tarefa em 'task_prompt'.");
  if (!text?.trim()) throw bad("Envie o texto do aluno em 'text'.");

  const out = await claude(env, {
    max_tokens: 3000,
    temperature: 0, // os motores são calibrados em temperatura 0 — não mexa sem rodar test_concordancia.py
    system: systemPrompt(level),
    messages: [{
      role: "user",
      content:
        `TASK TYPE: ${task_part}\n` +
        `TASK PROMPT (what the learner was asked to do):\n${task_prompt.trim()}\n\n` +
        `LEARNER'S TEXT (transcribed as written, errors preserved):\n${text.trim()}`
    }]
  });

  const result = parseJson(textOf(out));

  // Aritmética é nossa; julgamento é do motor.
  result.level = level;
  result.task_part = task_part;
  result.word_count = text.trim().split(/\s+/).filter(Boolean).length;
  result.min_words = tarefa.min_words;
  if (tarefa.max_words) result.max_words = tarefa.max_words;
  result.meets_word_minimum = result.word_count >= tarefa.min_words;
  result.subscales = nivel.subscales;              // 3 no A2, 4 do B1 pra cima
  result.calibrated = nivel.calibrated === true;
  result.needs_teacher_review = true;              // sempre true durante o piloto
  result.engine_version = "0.1";
  result.assessed_at = new Date().toISOString();
  if (student) result.student = student;

  // A média é conta, não opinião: recalculamos e não confiamos na do modelo.
  const bandas = nivel.subscales.map(s => result[s]?.band).filter(b => Number.isInteger(b));
  if (bandas.length === nivel.subscales.length) {
    result.overall_band = Math.floor(bandas.reduce((a, b) => a + b, 0) / bandas.length + 0.5);
  }

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
