"""Case metrics for the ID-survival stress suite (build-plan M4 exit
criteria): reattach rate over conceptually-surviving elements, orphan
correctness, and the invariant overridden = reattached + orphaned + silent."""

from orchestrator.stress import case_metrics


def test_all_survivors_reattach() -> None:
    metrics = case_metrics(
        overridden={"a.b.x", "a.b.y", "a.b.z"},
        expected_orphans=set(),
        attached={"a.b.x", "a.b.y", "a.b.z", "a.b.new"},
        declared=set(),
    )
    assert metrics["expected_survivors"] == 3
    assert metrics["reattached"] == 3
    assert metrics["silent_drops"] == []
    assert metrics["unexpected_orphans"] == []


def test_expected_orphan_declared_is_correct_not_a_failure() -> None:
    metrics = case_metrics(
        overridden={"a.b.x", "a.b.y"},
        expected_orphans={"a.b.y"},
        attached={"a.b.x"},
        declared={"a.b.y"},
    )
    assert metrics["expected_survivors"] == 1
    assert metrics["reattached"] == 1
    assert metrics["declared_orphans"] == ["a.b.y"]
    assert metrics["unexpected_orphans"] == []
    assert metrics["silent_drops"] == []


def test_survivor_dropped_but_declared_counts_against_reattach() -> None:
    metrics = case_metrics(
        overridden={"a.b.x", "a.b.y"},
        expected_orphans=set(),
        attached={"a.b.x"},
        declared={"a.b.y"},
    )
    assert metrics["reattached"] == 1
    assert metrics["unexpected_orphans"] == ["a.b.y"]
    assert metrics["silent_drops"] == []  # declared, so not silent


def test_silent_drop_detected() -> None:
    metrics = case_metrics(
        overridden={"a.b.x", "a.b.y"},
        expected_orphans=set(),
        attached={"a.b.x"},
        declared=set(),
    )
    assert metrics["silent_drops"] == ["a.b.y"]


def test_conservation_invariant_reported() -> None:
    # every overridden id lands in exactly one bucket
    metrics = case_metrics(
        overridden={"a", "b", "c", "d"},
        expected_orphans={"b"},
        attached={"a", "c"},
        declared={"b", "d"},
    )
    assert metrics["reattached"] == 2  # a, c
    assert set(metrics["declared_orphans"]) == {"b", "d"}
    assert metrics["silent_drops"] == []
    assert metrics["reattached"] + len(metrics["declared_orphans"]) + len(metrics["silent_drops"]) == 4
