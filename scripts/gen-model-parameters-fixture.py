"""Writes tests/fixtures/model_parameters_expected.json from the PYTHON SDK.

The Python SDK is the reference for how `model_parameters` land on a span, so
the expected half of the parity fixture is its output, not ours. Run it with
the Python SDK's interpreter and point it at that repo's `src`:

    <rius-sdk-python>/.venv/bin/python scripts/gen-model-parameters-fixture.py \
        <rius-sdk-python>/src

Read `origin/main` there (a `git archive` into a scratch directory works), not
a local checkout that may be stale. A fixture refreshed from the wrong
revision makes the test assert parity with something that never shipped.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])

from rius.generation import _request_attributes  # noqa: E402

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

cases = json.loads((FIXTURES / "model_parameters_input.json").read_text())["cases"]
expected = {
    case["name"]: {
        key: list(value) if isinstance(value, tuple) else value
        for key, value in _request_attributes(case["model_parameters"]).items()
    }
    for case in cases
}
(FIXTURES / "model_parameters_expected.json").write_text(
    json.dumps(expected, indent=2, ensure_ascii=False) + "\n"
)
print(f"wrote {len(expected)} cases")
