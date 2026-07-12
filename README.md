# Togethere — Writing Assessment

Avaliação automática de writing para a escola Togethere. O aluno envia uma redação (manuscrita ou digitada), o sistema lê via OCR, avalia contra a **Cambridge Writing Assessment Scale** e devolve um relatório com bandas, correções e sugestões — mapeado para os níveis internos da escola (A1–C2).

**Estado:** v0.1 — motor calibrado para **A2 Key for Schools** (Part 6 e-mail, Part 7 story). B1/B2/C1 em desenvolvimento.

## Estrutura

```
index.html                        Frontend (single-file, identidade visual Togethere)
assets/brand.json                 Tokens da marca: cores, tipografia, elementos gráficos
assets/logo.png                   ⚠️ adicionar — PNG oficial do Drive (NUSA › Logos › RGB › PNG)
data/assessment_result.schema.json Contrato de saída do motor (JSON Schema)
data/sample_result.json           Resultado de exemplo (alimenta o modo demo)
motor/prompt_a2.md                System prompt do LLM avaliador (A2 Key for Schools)
motor/gold_a2.json                Gabarito: amostras oficiais Cambridge com bandas de examinadores reais
motor/test_concordancia.py        Mede a concordância do motor contra o gabarito
docs/                             Arquitetura e rubrica (.docx)
private/                          Redações de alunos e PDFs do Cambridge — NÃO versionado
```

## Rodando o frontend

O `index.html` é estático — serve em GitHub Pages sem build:

```bash
python3 -m http.server 8000    # depois abra http://localhost:8000
```

Clique em **"Ver exemplo (modo demo)"** para renderizar o relatório com `data/sample_result.json`.

Para ligar ao backend real, edite `CONFIG.apiUrl` no topo do `<script>` em `index.html`.

> **Nunca coloque a chave da API no frontend.** O navegador chama o seu backend; o backend chama o modelo. Uma chave em HTML público é uma chave vazada.

## Rodando o teste de concordância

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-...
python motor/test_concordancia.py
```

Saída: tabela comparando as bandas geradas com as dos examinadores Cambridge + concordância exata e ±1 banda.

> **Regra:** mudou o prompt, a calibração está invalidada. Rode o teste antes de subir qualquer alteração em `motor/prompt_a2.md`.

## Subescalas

Content · Organisation · Language — cada uma de 0 a 5, conforme a Cambridge Writing Assessment Scale. O contrato completo do relatório está em `data/assessment_result.schema.json`.

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
