#!/usr/bin/env python3
"""
Teste de concordancia dos motores de avaliacao.

Roda o prompt de um nivel contra as amostras oficiais do Cambridge Assessing
Writing Guide daquele nivel e compara as bandas geradas com as bandas dadas
por examinadores Cambridge reais.

Uso:
    export ANTHROPIC_API_KEY=sk-...
    pip install anthropic
    python motor/test_concordancia.py a2      # ou b1, b2, c1
    python motor/test_concordancia.py todos

Saida: tabela de comparacao + concordancia exata e +/- 1 banda.
Rode isto sempre que mudar um prompt. Mudou o prompt = calibracao invalidada.

O bloco de system prompt e extraido do .md exatamente como o Worker faz
(worker/src/index.js, systemPrompt()). Se as duas extracoes divergirem, o que
foi testado aqui nao e o que roda em producao.
"""

import json
import os
import re
import sys
from pathlib import Path

try:
    from anthropic import Anthropic
except ImportError:
    sys.exit("Instale a lib: pip install anthropic")

HERE = Path(__file__).parent
MODEL = "claude-sonnet-5"
TEMPERATURE = 0.0
NIVEIS = ["a2", "b1", "b2", "c1"]


def system_prompt(nivel: str) -> str:
    """Extrai o bloco SYSTEM PROMPT do prompt_<nivel>.md — igual ao Worker."""
    md = (HERE / f"prompt_{nivel}.md").read_text(encoding="utf-8")
    inicio = md.index("## SYSTEM PROMPT") + len("## SYSTEM PROMPT")
    fim = md.index("## USER MESSAGE TEMPLATE")
    return md[inicio:fim].strip()


def avaliar(client, prompt, amostra):
    """Manda uma amostra ao motor e devolve as bandas por subescala."""
    msg = client.messages.create(
        model=MODEL,
        max_tokens=3000,
        temperature=TEMPERATURE,
        system=prompt,
        messages=[{
            "role": "user",
            "content": (
                f"TASK TYPE: {amostra['task_part']}\n"
                f"TASK PROMPT (what the learner was asked to do):\n{amostra['task_prompt']}\n\n"
                f"LEARNER'S TEXT (transcribed as written, errors preserved):\n{amostra['text']}"
            ),
        }],
    )
    bruto = "".join(b.text for b in msg.content if b.type == "text").strip()
    bruto = re.sub(r"^```(?:json)?\s*|\s*```$", "", bruto)
    dados = json.loads(bruto[bruto.index("{"): bruto.rindex("}") + 1])
    return {sub: dados[sub]["band"] for sub in amostra["gold"]}


def rodar(nivel, client):
    prompt = system_prompt(nivel)
    gold = json.loads((HERE / f"gold_{nivel}.json").read_text(encoding="utf-8"))
    subs = gold["subscales"]

    print(f"\n{'=' * 78}")
    print(f"{nivel.upper()} — {len(gold['samples'])} amostras x {len(subs)} subescalas")
    print("=" * 78)
    print(f"{'amostra':<10}{'subescala':<28}{'gold':>6}{'motor':>7}")

    exatos = perto = total = 0
    for a in gold["samples"]:
        try:
            obtido = avaliar(client, prompt, a)
        except Exception as e:                      # noqa: BLE001
            print(f"{a['id']:<10}ERRO: {e}")
            continue

        for sub in subs:
            g, m = a["gold"][sub], obtido[sub]
            d = abs(g - m)
            marca = "ok" if d == 0 else ("~" if d == 1 else "X")
            print(f"{a['id']:<10}{sub:<28}{g:>6}{m:>7}  {marca}")
            total += 1
            exatos += d == 0
            perto += d <= 1
        print()

    if total:
        print(f"{nivel.upper()}: concordancia exata {exatos}/{total} ({exatos / total:.0%}) | "
              f"+/-1 banda {perto}/{total} ({perto / total:.0%})")
    return exatos, perto, total


def main():
    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("Defina ANTHROPIC_API_KEY.")

    alvo = (sys.argv[1] if len(sys.argv) > 1 else "a2").lower()
    niveis = NIVEIS if alvo in ("todos", "all") else [alvo]
    for n in niveis:
        if n not in NIVEIS:
            sys.exit(f"Nivel '{n}' nao tem motor. Disponiveis: {', '.join(NIVEIS)}")

    client = Anthropic()
    e = p = t = 0
    for n in niveis:
        ne, np_, nt = rodar(n, client)
        e, p, t = e + ne, p + np_, t + nt

    if len(niveis) > 1 and t:
        print(f"\n{'=' * 78}")
        print(f"GERAL: exata {e}/{t} ({e / t:.0%}) | +/-1 banda {p}/{t} ({p / t:.0%})")

    # Referencia: examinadores humanos treinados concordam exatamente em torno de
    # 60-70% das vezes e ficam dentro de +/-1 banda quase sempre. E esse o alvo.
    # Concordancia exata baixa com +/-1 alto = motor util, mas revise o prompt.
    # +/-1 baixo = nao mostre a nota a ninguem ate consertar.


if __name__ == "__main__":
    main()
