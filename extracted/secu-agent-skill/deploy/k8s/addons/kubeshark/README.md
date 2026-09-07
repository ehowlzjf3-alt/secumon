# Kubeshark

Kubeshark is an optional traffic observability add-on. Install it only in an
approved lab or troubleshooting window because it captures cluster traffic.

```bash
deploy/k8s/bin/secu-k8s preflight deploy kubeshark
deploy/k8s/bin/secu-k8s install-kubeshark
deploy/k8s/bin/secu-k8s port-forward kubeshark
```

Open `http://localhost:8899`, then filter by namespace/workload labels:

- Namespace: `secu-agent`
- Domain label: `secu-agent.io/domain`
- Components: `collector`, `task`, `report-mail`, `reply-verify`, `runner`, `web`

For cleanup:

```bash
helm uninstall kubeshark
```
