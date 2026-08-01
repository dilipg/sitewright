"""Shields `${...}` from Kitaru's environment-variable substitution.

Kitaru runs every replayed value through zenml's
`substitute_env_variable_placeholders` with `raise_when_missing=True` and the
pattern `\\$\\{([a-zA-Z0-9_]+)\\}`. Our prompts are full of TSX, and contract
5.2 REQUIRES the list-item id pattern `` `${nodeId}.item-${item.key}` `` — so
`${nodeId}` sits verbatim in the stored prompt of almost every section, and
replay dies with:

    Unable to substitute environment variable placeholder 'nodeId'
    because the environment variable is not set.

That made section regeneration -- the PRD's differentiating loop -- impossible
for 19 of the 20 catalogued archetypes. `hero` is the sole exception, and it is
the only section M4's ID-survival suite and 5.5's regen check ever exercised,
which is why a 100%-reattach result coexisted with a feature that could not run
(docs/decisions.md 2026-07-30).

There is no escape syntax in that regex to exploit: `$${nodeId}` still contains
a match. So values are shielded on the way IN to a checkpoint or a flow
override, and unshielded at the point of use. The stored value round-trips
exactly; only Kitaru's substitution pass ever sees the shielded form.

Note `${item.key}` is NOT affected (the dot excludes it from the pattern) —
only bare identifiers are, which is precisely why shielding `${` alone is
enough.
"""

# Deliberately not a TSX-plausible string: it must never occur in real prompt
# text, and it must survive JSON round-tripping through the checkpoint store.
SENTINEL = "@@KITARU_DOLLAR_BRACE@@"


def shield(text: str) -> str:
    """Makes `${` invisible to Kitaru's placeholder substitution."""
    return text.replace("${", SENTINEL)


def unshield(text: str) -> str:
    """Restores shielded text to exactly what was passed to shield()."""
    return text.replace(SENTINEL, "${")


def shield_value(value: object) -> object:
    """shield() for a checkpoint/flow-override value of unknown type. Walks
    containers so a dict of overrides can be shielded wholesale; anything that
    is not a string is returned untouched."""
    if isinstance(value, str):
        return shield(value)
    if isinstance(value, list):
        return [shield_value(item) for item in value]
    if isinstance(value, dict):
        return {key: shield_value(item) for key, item in value.items()}
    return value
