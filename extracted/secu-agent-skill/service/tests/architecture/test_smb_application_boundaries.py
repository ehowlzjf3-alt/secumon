"""Architecture boundary checks for the SMB application layer."""
from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
APPLICATION_DIR = ROOT / "domains" / "smb" / "application"


def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            out.append(node.module)
    return out


def test_smb_application_layer_does_not_import_service_or_web_adapters() -> None:
    forbidden = ("service", "webapp")
    offenders: list[str] = []
    for path in sorted(APPLICATION_DIR.glob("*.py")):
        for module in _imports(path):
            if module == "service" or module == "webapp" or module.startswith(forbidden):
                offenders.append(f"{path.relative_to(ROOT)} imports {module}")

    assert offenders == []
