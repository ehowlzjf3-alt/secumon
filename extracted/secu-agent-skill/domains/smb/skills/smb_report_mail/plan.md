# smb_report_mail plan contract

kind: fanout_phase
skill: smb_report_mail
phase: report_mail
adapter: smb_report_mail
target_unit: mail_thread
target_source: mail_thread.status == reported
claim_function: service.state_domain.mail_thread_claim_next(status='reported')
worker_module: service.agents.report_mail_worker
worker_skill_resource: worker.md
concurrency_env: SMB_REPORT_MAIL_PARALLEL
default_concurrency: 2
terminal_success: deliver tool called and delivery_mode == sent
success_release: sent delivery moves thread to awaiting_reply
failure_release: dry-run or pre-delivery failure leaves thread outside awaiting_reply

Parent/orchestrator responsibilities:

- Claim reported mail_thread rows only.
- Do not build report bodies in parent context.
- Fan out one thread per worker.
- Read only worker_result.json when each worker exits.
