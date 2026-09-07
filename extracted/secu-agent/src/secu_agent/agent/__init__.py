"""secu-agent agent — 한 task 스코프를 자동으로 점검하는 LLM agent.

흐름:
  1. evidence_dir + task_spec (type/target) 받음
  2. LLM이 agent_type 도구들로 자산 enumerate → fetch → scan_text → drill
  3. submit_finding으로 finding.json 적재하면 종료

진입점:
  python -m secu_agent.agent <evidence_dir>
또는 secu_agent.cli가 자동 호출.
"""
