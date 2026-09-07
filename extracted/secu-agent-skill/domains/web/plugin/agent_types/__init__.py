"""web 도메인 agent_type — bs4 HTML 파싱 의존 격리.

`webdomain.py` 가 BeautifulSoup(bs4) 로 페이지를 파싱한다 — 이 도메인의 유일한
bs4 사용처. 재부착 시 `secu_agent/agent_types/` 상대구조로 복귀.
모두 read-only. url_safety 하드블록은 코어 잔류(엔진 소유).
"""
