# smb_reply_verify plan contract

kind: fanout_phase
skill: smb_reply_verify
phase: reply_verify
adapter: smb_reply_verify
target_unit: mail_thread
target_source: mail_thread.status == reply_received
claim_function: service.state_domain.mail_thread_claim_next(status='reply_received')
worker_module: service.agents.reply_verify_worker
worker_skill_resource: worker.md
concurrency_env: SMB_REPLY_VERIFY_PARALLEL
default_concurrency: 2
terminal_success: deliver tool called and worker_result.status == ok
success_release: worker moves thread to remediated/awaiting_reply/reply_received
failure_release: return thread to reply_received

Parent/orchestrator responsibilities:

- Polling inbox is a collector/passive input concern; fanout workers consume already matched threads.
- Claim one reply_received thread per worker.
- Keep reply body and reverify transcript out of parent context except worker_result summary.
