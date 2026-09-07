# Jenkins domain k8s status

Jenkins currently has per-service skill and tool code under
`domains/services/jenkins`, but it does not yet have a dedicated queue,
pipeline runner, or web dashboard like SMB, dev_web, GitHub, and Confluence.

This folder is intentionally limited to a status ConfigMap so Headlamp/K9s
show the domain as present but not runnable. Do not add a fake always-on
Deployment until there is a real Jenkins application/runner contract.
