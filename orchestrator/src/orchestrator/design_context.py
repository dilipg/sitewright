"""DESIGN CONTEXT block builder (pipeline 4.1): a compact token summary +
primitive inventory signatures. This block repeats in every section call —
the biggest repeated cost in the budget — so it must stay under 600 tokens."""

import math


def estimate_tokens(text: str) -> int:
    """Conservative token estimate. English+code averages ~4 chars/token;
    dividing by 3.5 deliberately overcounts so the <600 budget check cannot
    pass on an undercount. (No local tokenizer exists for Claude models.)"""
    if not text:
        return 0
    return math.ceil(len(text) / 3.5)


def build_design_context(tokens: dict, primitive_signatures: list[str]) -> str:
    color = tokens.get("color", {})
    typography = tokens.get("typography", {})

    semantic = ", ".join(color.get("semantic", {}))
    scale = " ".join(typography.get("scale", {}))
    weight = " ".join(typography.get("weight", {}))
    leading = " ".join(typography.get("leading", {}))
    families = " ".join(typography.get("fontFamily", {}))
    space = " ".join(tokens.get("space", {}))
    radius = " ".join(tokens.get("radius", {}))
    shadow = " ".join(tokens.get("shadow", {}))

    lines = [
        "[TOKENS] Style ONLY with Tailwind utilities over these token CSS vars:",
        f"- color.semantic ({semantic}) -> bg-(--color-semantic-K) text-(--color-semantic-K) border-(--color-semantic-K)",
        f"- typography.scale ({scale}) -> text-(length:--typography-scale-K)",
        f"- typography.weight ({weight}) -> font-(--typography-weight-K)",
        f"- typography.leading ({leading}) -> leading-(--typography-leading-K)",
        f"- typography.fontFamily ({families}) -> font-(family-name:--typography-fontFamily-K)",
        f"- space: {space} -> p/px/py/pt/pb/m/mt/mb/gap-(--space-K)",
        f"- radius: {radius} -> rounded-(--radius-K) | shadow: {shadow} -> shadow-(--shadow-K)",
        "Structural utilities (flex, grid, items-*, justify-*, text-center, mx-auto, w-full,",
        "max-w-[<rem>], min-h-screen, uppercase, tracking-[<em>], no-underline) are allowed.",
        "",
        "[PRIMITIVES] Compose ONLY these, imported from ../../../primitives/<Name>:",
        *(f"- {signature}" for signature in primitive_signatures),
    ]
    return "\n".join(lines)
