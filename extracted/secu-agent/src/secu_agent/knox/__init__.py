"""Knox 메신저 ↔ secu-agent 브릿지.

`~/project/knox` 의 KnoxTeams 릴레이 데몬(기본 127.0.0.1:8771)에 붙어, chatroom 하나를
ChatSession 하나로 매핑하는 양방향 프론트엔드. 인가된 사용자가 방에 보낸 메시지가 그 방의
점검 세션을 구동하고 agent 응답·진행·finding 이 같은 방으로 되돌아간다.

웹(WS) 프론트엔드와 동일한 ChatSession.load(...) → sess.turn() 경로를 미러링한다.
"""
