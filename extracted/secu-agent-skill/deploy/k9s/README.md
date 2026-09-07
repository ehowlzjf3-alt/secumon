# K9s

K9s is a local terminal UI, not a cluster workload. Install it locally and point
it at the same kubeconfig used for the `secu-agent` cluster.

```bash
deploy/k8s/bin/secu-k8s preflight local visualization
deploy/k8s/bin/secu-k8s k9s
```

Useful filters:

```text
/secu-agent.io/domain=smb
/secu-agent.io/domain=github
/secu-agent.io/domain=confluence
/app.kubernetes.io/component=runner
```

Useful port-forwards from K9s or `kubectl`:

```bash
kubectl -n secu-agent port-forward svc/secu-agent-smb-web 8767:8767
kubectl -n secu-agent port-forward svc/secu-agent-dev-web-web 8769:8769
kubectl -n secu-agent port-forward svc/secu-agent-github-web 8770:8770
kubectl -n secu-agent port-forward svc/secu-agent-confluence-web 8773:8773
```
