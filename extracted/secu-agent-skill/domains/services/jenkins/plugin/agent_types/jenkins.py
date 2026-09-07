"""Jenkins 에이전트.

Jenkins XML API + console log. 가장 자주 새는 자료:
  - job config.xml — 평문 password/token이 environment 변수에 박혀있는 경우
  - build console log — Pipeline에서 echo 실수, terraform apply 출력에 키 포함
  - credentials.xml (system) — root credentials store. 권한 없으면 403.

읽기 전용. job 트리거/취소/설정변경 절대 안 함.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)


def _client() -> httpx.Client:
    base = os.environ.get("JENKINS_BASE_URL", "").rstrip("/")
    user = os.environ.get("JENKINS_USER", "")
    token = os.environ.get("JENKINS_API_TOKEN", "")
    if not base:
        raise RuntimeError("JENKINS_BASE_URL 미설정")
    auth = (user, token) if user and token else None
    return httpx.Client(
        base_url=base, auth=auth, timeout=20.0, verify=False,
        headers={"User-Agent": "secu-agent/0.1"},
    )


@dataclass(slots=True)
class JenkinsJob:
    full_name: str       # folder1/folder2/job 형식
    url: str
    last_build_number: int | None


@dataclass(slots=True)
class JenkinsBuild:
    job_full_name: str
    number: int
    url: str
    result: str | None


def list_jobs(*, limit: int = 300) -> list[JenkinsJob]:
    """folder 재귀. api/json depth=10 으로 한 번에 긁음."""
    out: list[JenkinsJob] = []
    with _client() as c:
        # tree로 필요한 필드만 받기 (페이로드 절감)
        tree = (
            "jobs[fullName,url,lastBuild[number],"
            "jobs[fullName,url,lastBuild[number],"
            "jobs[fullName,url,lastBuild[number]]]]"
        )
        r = c.get("/api/json", params={"tree": tree})
        r.raise_for_status()
        _flatten_jobs(r.json().get("jobs", []), out, limit)
    return out


def _flatten_jobs(nodes: list[dict], out: list[JenkinsJob], limit: int) -> None:
    for n in nodes:
        if "jobs" in n and n["jobs"]:
            _flatten_jobs(n["jobs"], out, limit)
        elif "fullName" in n:
            out.append(JenkinsJob(
                full_name=n["fullName"],
                url=n.get("url", ""),
                last_build_number=(n.get("lastBuild") or {}).get("number"),
            ))
            if len(out) >= limit:
                return


def fetch_job_config(job_full_name: str) -> str | None:
    """job/<path>/config.xml. folder 권한 따라 403/404 흔함."""
    job_path = "/".join(f"job/{p}" for p in job_full_name.split("/"))
    with _client() as c:
        r = c.get(f"/{job_path}/config.xml")
        if r.status_code in (401, 403, 404):
            return None
        r.raise_for_status()
        return r.text


def list_recent_builds(job_full_name: str, *, count: int = 3) -> list[JenkinsBuild]:
    out: list[JenkinsBuild] = []
    job_path = "/".join(f"job/{p}" for p in job_full_name.split("/"))
    with _client() as c:
        r = c.get(f"/{job_path}/api/json", params={"tree": f"builds[number,url,result]{{0,{count}}}"})
        if r.status_code != 200:
            return out
        for b in r.json().get("builds", []):
            out.append(JenkinsBuild(
                job_full_name=job_full_name,
                number=b["number"],
                url=b.get("url", ""),
                result=b.get("result"),
            ))
    return out


def fetch_console_log(job_full_name: str, build_number: int, *, max_bytes: int = 512 * 1024) -> str | None:
    job_path = "/".join(f"job/{p}" for p in job_full_name.split("/"))
    with _client() as c:
        r = c.get(f"/{job_path}/{build_number}/consoleText")
        if r.status_code != 200:
            return None
        raw = r.content[:max_bytes]
        return raw.decode("utf-8", errors="replace")


def fetch_credentials_xml() -> str | None:
    """root credentials store. 권한 거의 admin only — 403/401 정상."""
    with _client() as c:
        r = c.get("/credentials/store/system/domain/_/api/xml")
        if r.status_code != 200:
            return None
        return r.text
