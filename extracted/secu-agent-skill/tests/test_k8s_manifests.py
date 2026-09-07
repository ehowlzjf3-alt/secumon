from __future__ import annotations

import os
import importlib
import shutil
import stat
import subprocess
import tomllib
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SECU_K8S = ROOT / "deploy/k8s/bin/secu-k8s"


def _kubectl_kustomize(path: str) -> str:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        pytest.skip("kubectl is not installed")
    result = subprocess.run(
        [kubectl, "kustomize", str(ROOT / path)],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def _run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    run_env = os.environ.copy()
    if env:
        run_env.update(env)
    return subprocess.run(
        [str(SECU_K8S), *args],
        check=False,
        env=run_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def test_all_domain_overlay_renders_domain_workloads() -> None:
    rendered = _kubectl_kustomize("deploy/k8s/overlays/all")

    expected_names = [
        "secu-agent-smb-web",
        "secu-agent-smb-collector",
        "secu-agent-smb-task",
        "secu-agent-smb-report-mail",
        "secu-agent-smb-reply-verify",
        "secu-agent-dev-web-web",
        "secu-agent-dev-web-discovery",
        "secu-agent-dev-web-task",
        "secu-agent-dev-web-report",
        "secu-agent-dev-web-reverify",
        "secu-agent-github-web",
        "secu-agent-github-runner",
        "secu-agent-confluence-web",
        "secu-agent-confluence-runner",
        "secu-agent-jenkins-deployment-status",
    ]
    for name in expected_names:
        assert f"name: {name}" in rendered

    for domain in ("smb", "dev-web", "github", "confluence", "jenkins"):
        assert f"secu-agent.io/domain: {domain}" in rendered

    # ★ 발송을 막는 **진짜 게이트**는 이것이다 — 싱크가 비어 있으면 전부 드라이런이다.
    assert 'SA_DELIVERY_AUTOSEND_SINKS: ""' in rendered

    # ⚠️ 아래는 **수신처 정책**이지 발송 여부가 아니다. 2026-08-26 `7b46df0` 이
    #    `dssoc_only` → `normal`(담당자 To + DSSOC Cc)로 바꿨는데 이 단언만 남아
    #    스윗이 계속 빨간불이었다. 정책이 바뀌었으면 단언도 같이 바뀌어야 한다 —
    #    안 그러면 "늘 실패하는 테스트" 가 되어 진짜 드리프트를 가린다.
    #    4도메인이 **같은 값**인지까지 본다(한 도메인만 어긋나는 것이 실제 사고 형태였다).
    for domain in ("SMB", "GITHUB", "CONFLUENCE", "DEV_WEB"):
        assert f"{domain}_REMEDIATION_MAIL_MODE: normal" in rendered

    expected_modules = [
        "domains.smb.webapp.app",
        "domains.smb.runners.collector",
        "domains.smb.runners.task",
        "domains.smb.runners.report_mail",
        "domains.smb.runners.reply_verify",
        "domains.dev_web.webapp.app",
        "domains.dev_web.runners.discovery",
        "domains.dev_web.runners.task",
        "domains.dev_web.runners.report",
        "domains.dev_web.runners.reverify",
        "domains.services.github.webapp.app",
        "domains.services.github.runners.pipeline",
        "domains.services.confluence.webapp.app",
        "domains.services.confluence.runners.pipeline",
    ]
    for module in expected_modules:
        assert module in rendered


def test_headlamp_viewer_rbac_renders_namespace_scoped_token() -> None:
    rendered = _kubectl_kustomize("deploy/k8s/addons/headlamp")

    assert "name: secu-agent-headlamp-viewer" in rendered
    assert "kind: RoleBinding" in rendered
    assert "kind: ClusterRoleBinding" in rendered
    assert "name: secu-agent-headlamp-viewer-cluster-view" in rendered
    assert "kind: ClusterRole" in rendered
    assert "name: secu-agent-headlamp-cluster-metadata-viewer" in rendered
    assert "name: view" in rendered
    assert "resources:\n  - nodes\n  - persistentvolumes" in rendered
    assert "kind: Secret" in rendered
    assert "kubernetes.io/service-account-token" in rendered


def test_kind_overlay_renders_local_postgres_and_runtime_secret() -> None:
    rendered = _kubectl_kustomize("deploy/k8s/overlays/kind")

    assert "name: secu-agent-postgres" in rendered
    assert "image: postgres:16-bookworm" in rendered
    assert "name: secu-agent-runtime" in rendered
    assert "SECU_AGENT_PG_DSN:" in rendered
    assert "DATABASE_URL:" not in rendered


def test_runtime_secret_example_uses_engine_postgres_dsn_name() -> None:
    secret_example = (ROOT / "deploy/k8s/base/runtime-secret.example.yaml").read_text(
        encoding="utf-8"
    )

    assert "SECU_AGENT_PG_DSN:" in secret_example
    assert "DATABASE_URL:" not in secret_example


def test_secu_k8s_operator_script_parses_and_exposes_targets() -> None:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not installed")
    result = subprocess.run(
        [bash, "-n", str(SECU_K8S)],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    assert result.returncode == 0, result.stderr
    assert os.access(SECU_K8S, os.X_OK)

    help_result = _run("--help")
    assert help_result.returncode == 0
    for target in (
        "preflight",
        "kind",
        "smb",
        "dev-web",
        "github",
        "confluence",
        "jenkins",
        "headlamp",
        "kubeshark",
        "visualization",
    ):
        assert target in help_result.stdout


def test_secu_k8s_render_uses_the_same_kustomize_targets() -> None:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        pytest.skip("kubectl is not installed")

    all_render = _run("render", "all")
    headlamp_render = _run("render", "headlamp")

    assert all_render.returncode == 0, all_render.stderr
    assert headlamp_render.returncode == 0, headlamp_render.stderr
    assert "name: secu-agent-smb-web" in all_render.stdout
    assert "name: secu-agent-headlamp-viewer" in headlamp_render.stdout


def test_secu_k8s_render_applies_image_override() -> None:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        pytest.skip("kubectl is not installed")

    custom_image = "registry.example/secu-agent-skill:test"
    rendered = _run("render", "smb", env={"SECU_K8S_IMAGE": custom_image})

    assert rendered.returncode == 0, rendered.stderr
    assert f"image: {custom_image}" in rendered.stdout
    assert "image: secu-agent-skill:local" not in rendered.stdout


def test_secu_k8s_render_applies_postgres_image_override() -> None:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        pytest.skip("kubectl is not installed")

    custom_image = "registry.example/postgres:16-bookworm"
    rendered = _run("render", "kind", env={"SECU_K8S_POSTGRES_IMAGE": custom_image})

    assert rendered.returncode == 0, rendered.stderr
    assert f"image: {custom_image}" in rendered.stdout
    assert "image: postgres:16-bookworm" not in rendered.stdout


def test_secu_k8s_build_image_forwards_optional_pip_build_args(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    args_file = tmp_path / "docker-args.txt"
    docker = fake_bin / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$@\" > \"$SECU_FAKE_DOCKER_ARGS\"\n",
        encoding="utf-8",
    )
    docker.chmod(docker.stat().st_mode | stat.S_IXUSR)

    result = _run(
        "build-image",
        env={
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "SECU_ENGINE_DIR": str(engine_dir),
            "SECU_FAKE_DOCKER_ARGS": str(args_file),
            "SECU_PIP_INDEX_URL": "https://pypi.example/simple",
            "SECU_PIP_TRUSTED_HOST": "pypi.org files.pythonhosted.org",
            "SECU_PIP_CERT": "/etc/ssl/certs/company-ca.pem",
        },
    )

    assert result.returncode == 0, result.stderr
    args = args_file.read_text(encoding="utf-8")
    assert "buildx\nbuild\n" in args
    assert "--build-arg\nSECU_PIP_INDEX_URL=https://pypi.example/simple\n" in args
    assert "--build-arg\nSECU_PIP_TRUSTED_HOST=pypi.org files.pythonhosted.org\n" in args
    assert "--build-arg\nSECU_PIP_CERT=/etc/ssl/certs/company-ca.pem\n" in args


def test_container_runtime_user_owns_editable_source_paths() -> None:
    dockerfile = (ROOT / "deploy/container/Dockerfile").read_text(encoding="utf-8")

    assert "USER 10001" in dockerfile
    assert "COPY --from=engine --chown=10001:10001 . /app/engine" in dockerfile
    assert "COPY --from=skill --chown=10001:10001 . /app/skill" in dockerfile


def test_container_runtime_dependencies_include_engine_postgres_pool() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = pyproject["project"]["dependencies"]

    assert any(dep.startswith("psycopg[binary]") for dep in dependencies)
    assert any(dep.startswith("psycopg-pool") for dep in dependencies)


def test_visualization_install_is_kind_friendly() -> None:
    script = SECU_K8S.read_text(encoding="utf-8")

    assert "SECU_HEADLAMP_IMAGE" in script
    assert "SECU_KUBESHARK_FRONT_IMAGE" in script
    assert "tap.docker.imagePullPolicy=IfNotPresent" in script
    assert "cloudLicenseEnabled=false" in script
    assert "tap.telemetry.enabled=false" in script
    assert "SECU_KUBESHARK_HUB_PROBE_INITIAL_DELAY" in script


def test_secu_k8s_preflight_local_checks_render_without_cluster_access() -> None:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        pytest.skip("kubectl is not installed")

    result = _run("preflight", "local", "all")

    assert result.returncode == 0, result.stderr
    assert "ok: render all" in result.stdout
    assert "ok: render headlamp" in result.stdout
    assert "preflight local passed" in result.stdout


def test_domain_local_entrypoints_import() -> None:
    modules = [
        "domains.smb.webapp.app",
        "domains.smb.runners.collector",
        "domains.smb.runners.task",
        "domains.smb.runners.report_mail",
        "domains.smb.runners.reply_verify",
        "domains.dev_web.webapp.app",
        "domains.dev_web.runners.discovery",
        "domains.dev_web.runners.task",
        "domains.dev_web.runners.report",
        "domains.dev_web.runners.reverify",
        "domains.services.github.runners.pipeline",
        "domains.services.confluence.runners.pipeline",
    ]

    for module_name in modules:
        module = importlib.import_module(module_name)
        assert callable(module.main)
