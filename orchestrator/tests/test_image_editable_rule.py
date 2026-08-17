"""Every archetype template must tell the model that an Image node is text-editable.

REPORTED BY A TESTER. They selected an image, typed an instruction into the
prompt box, and got:

    "features.feature-spotlights.feature-ai-insights.image" cannot be edited
    through text

The rejection was CORRECT given the data — that node's manifest entry declared
`editable: ["style", "visibility"]` — and the data was wrong. Two documented
requirements have to hold together:

  * PRD 3.5: replacing an `Image`'s source is "override channel `text` with key
    `src` (content, not style)".
  * PRD 3.6 requirement 4: "A node is editable only through a channel its
    manifest entry declares."

So an Image node's entry MUST declare `text`, or image replace is unreachable
through the prompt box. The templates were the cause: their guidance said
`editable lists only channels that make sense (text only where copy renders)`,
and an image renders no copy — so the model dutifully left `text` off, and
21 of the 28 templates gave no guidance on the point at all.

WHY A TEST AND NOT JUST THE EDIT. Twenty-eight files now carry one sentence that
nothing else references. A later pass that rewords the OUTPUT FORMAT footer — the
most-edited block in every template — would drop it silently from any subset,
and the symptom would not appear until someone tried to replace an image through
the prompt box on a newly generated site.

NOT COVERED HERE, deliberately: whether the MODEL obeys. That needs a live
generation. This pins only that every template says it, which is the part that
regressed to nothing without anyone noticing.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TEMPLATES = sorted((Path(__file__).resolve().parents[2] / "prompts" / "archetypes").glob("*.md"))


def test_the_catalog_is_not_empty() -> None:
    """A premise guard: a glob that silently matched nothing would make every
    parametrised test below vacuously pass."""
    assert len(TEMPLATES) >= 20, f"expected the full archetype catalog, found {len(TEMPLATES)}"


@pytest.mark.parametrize("template", TEMPLATES, ids=lambda p: p.name)
def test_template_states_that_an_image_node_is_text_editable(template: Path) -> None:
    body = template.read_text(encoding="utf-8")
    assert "an Image node ALWAYS includes" in body, (
        f"{template.name} does not tell the model that an Image node's `editable` must "
        'include "text". Without it the model omits the channel (an image renders no '
        "copy), and image replace becomes unreachable through the prompt box — the exact "
        "defect a tester hit. See PRD 3.5 and 3.6 requirement 4."
    )


@pytest.mark.parametrize("template", TEMPLATES, ids=lambda p: p.name)
def test_the_rule_names_the_key_the_channel_carries(template: Path) -> None:
    """`src` specifically. A text override on an image with any other key is not
    image replace, and the exporter rewrites the mock field bound to the `src`
    JSX attribute (contract 7.1)."""
    body = template.read_text(encoding="utf-8")
    rule = body[body.index("an Image node ALWAYS includes") :][:400]
    assert '"src"' in rule, f"{template.name}'s Image rule does not name the key `src`"


@pytest.mark.parametrize("template", TEMPLATES, ids=lambda p: p.name)
def test_no_example_shows_an_image_without_the_text_channel(template: Path) -> None:
    """The worked examples must not contradict the rule.

    A template that STATES the rule and then shows `main-image (Image; style,
    visibility)` in its own worked example is worse than one that says nothing:
    the example is the part the model imitates.
    """
    body = template.read_text(encoding="utf-8")
    for match in re.finditer(r"\(Image[^)]{0,60}\)", body):
        assert "text" in match.group(0), (
            f"{template.name} has a worked example {match.group(0)!r} that omits the text "
            "channel, contradicting the rule stated in the same file"
        )
