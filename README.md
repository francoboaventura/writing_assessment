# Togethere — Writing Assessment

Avaliação automática de writing para a escola Togethere. O aluno envia uma redação (manuscrita ou digitada), o sistema lê via OCR, avalia contra a **Cambridge Writing Assessment Scale** e devolve um relatório com bandas, correções e sugestões — mapeado para os níveis internos da escola (A1–C2).

**Estado:** v0.1 — motor calibrado para **A2 Key for Schools** (Part 6 e-mail, Part 7 story). B1/B2/C1 em desenvolvimento.

## Estrutura

```
index.html                         Frontend (single-file, identidade visual Togethere)
assets/brand.json                  Tokens da marca: cores, tipografia, elementos gráficos
assets/logo.png                    ⚠️ adicionar — PNG oficial do Drive (NUSA › Logos › RGB › PNG)
worker/src/index.js                API: /transcribe (OCR) e /assess (avaliação)
worker/wrangler.toml               Config do Cloudflare Worker
data/assessment_result.schema.json Contrato de saída do motor (JSON Schema)
data/sample_result.json            Resultado de exemplo (alimenta o modo demo)
motor/prompt_a2.md                 System prompt do avaliador — fonte da verdade do contrato
motor/gold_a2.json                 Gabarito: amostras oficiais Cambridge com bandas de examinadores reais
motor/test_concordancia.py         Mede a concordância do motor contra o gabarito
docs/                              Arquitetura e rubrica (.docx)
private/                           Redações de alunos e PDFs do Cambridge — NÃO versionado
```

## Como roda

```
navegador (GitHub Pages)  →  Cloudflare Worker  →  Claude
   index.html                worker/src/index.js    prompt_a2.md
```

A chave da API vive **só no Worker**, como secret. O frontend nunca a vê — ele é público.

### 1. Backend (Cloudflare Worker)

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY   # cola a chave; ela não vai pro git
npx wrangler deploy
```

Antes do deploy, ajuste `ALLOWED_ORIGINS` no `wrangler.toml` para a URL do seu Pages — sem isso, qualquer site pode chamar a sua API e gastar a sua cota.

O deploy imprime a URL do Worker. Cole-a em `CONFIG.apiUrl`, no topo do `<script>` do `index.html`, e faça commit.

Testando direto:

```bash
curl -X POST https://SEU-WORKER.workers.dev/assess \
  -H 'Content-Type: application/json' \
  -d '{"task_part":"part6_email","task_prompt":"Write an email to Chris...","text":"Hello Chris! We coming to the museum."}'
```

### 2. Frontend

Estático, sem build. Local:

```bash
python3 -m http.server 8000    # http://localhost:8000
```

Em produção é o próprio GitHub Pages. **"Ver exemplo (modo demo)"** renderiza o relatório a partir de `data/sample_result.json` — funciona mesmo sem Worker.

### 3. Fluxo do OCR

Manuscrito passa por dois passos, de propósito: **Transcrever a foto** → o professor/aluno confere o texto → **Avaliar**. O motor exige o texto confirmado, nunca o bruto do OCR, para que um erro de leitura não vire erro de escrita na nota.

## Rodando o teste de concordância

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-...
python motor/test_concordancia.py
```

Saída: tabela comparando as bandas geradas com as dos examinadores Cambridge + concordância exata e ±1 banda.

> **Regra:** mudou o prompt, a calibração está invalidada. Rode o teste antes de subir qualquer alteração em `motor/prompt_a2.md`.

## Subescalas e bandas

Content · Organisation · Language — cada uma de 0 a 5, conforme a Cambridge Writing Assessment Scale. As três são **independentes**: um aluno pode tirar 5 em Content e 2 em Language.

| overall_band | Togethere | CEFR |
|---|---|---|
| 5 | DISTINCTION | ≥ A2 (strong) |
| 4 | MERIT | ≥ A2 |
| 3 | PASS | A2 achieved |
| 0–2 | UNSATISFACTORY | below A2 |

Contrato completo do relatório: `data/assessment_result.schema.json`. A fonte da verdade é a seção *Output format* do `motor/prompt_a2.md` — mudou lá, muda o schema e o `render()` do `index.html`.

## Identidade visual

Do Manual da Identidade Visual (Nusa Brands). Ver `assets/brand.json`.

| | |
|---|---|
| Azul | `#005EAF` |
| Vermelho | `#E52524` |
| Amarelo | `#FFC800` |
| Apoio | `#FF005F` · `#FF2A00` · `#002B64` · `#DF6DFF` |
| Títulos | Zilla Slab SemiBold Italic |
| Textos | Urbanist Light |

## Privacidade

Redações de alunos e o material licenciado do Cambridge (UCLES) ficam em `private/`, fora do controle de versão. **Não commite dados identificáveis de alunos neste repositório** — ele é público.
