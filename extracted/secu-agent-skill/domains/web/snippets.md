# web_tasking / snippets — 검증된 패턴 (stub)

> 재배치 시 신설 stub. SKILL.md 본문에 이미 풍부한 절차/SPL 이 있어 여기엔 포인터만.
> 채울 자리: 재사용 코드 스니펫(표준 endpoint sweep 목록, scope 자기검열 assert 등).

## 표준 endpoint sweep (SKILL.md "Standard endpoint sweep" 참조)

```
API spec : /openapi.json /docs /redoc /api/docs /swagger /swagger.json /swagger-ui
discovery: /.well-known/security.txt /.well-known/openid-configuration /robots.txt /sitemap.xml
민감 leak : /.env /.git/config /server-status /actuator/health /actuator/env /metrics /debug
admin    : /admin /login /console
```

## scope 자기검열 (SKILL.md "Strict scope" 참조)

```python
user_lines = [l.strip() for l in user_input.split('\n') if l.strip()]
seeds_to_scan = [...]
assert len(seeds_to_scan) == len(user_lines), "scope 위반"
for s in seeds_to_scan:
    assert s in user_lines, f"scope 위반: '{s}'"
```

## 일일 unique 사이트 SPL (SKILL.md "SIEM 우선" 참조)

```spl
index=hq_escort_stats sourcetype=escort_web_log
earliest=-1d@d latest=@d cdep.samsungds.net
| dedup domain | table domain
```

> TODO: 라이브 검증된 web_site_sweep 호출 스니펫·디지스트 판독 패턴 추가.
