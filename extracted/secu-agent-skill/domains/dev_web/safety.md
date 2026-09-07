# dev_web / safety

- Authorized internal use only; keep `charter_ref` on agent runs.
- Read-only inspection. Do not write, save, submit forms, delete, send messages,
  brute-force, or bypass authentication.
- Stay in the queued URL's same origin unless the user explicitly expands scope.
- Browser/rendered evidence is required for UI exposure claims.
- `web_task_scan` and keyword hits are leads only.
- Mask PII, secrets, tokens, and business-sensitive values in findings and mail.
- Report dev/stage/test risk as internal unauthenticated or under-authorized
  access, not generic internet exposure.
