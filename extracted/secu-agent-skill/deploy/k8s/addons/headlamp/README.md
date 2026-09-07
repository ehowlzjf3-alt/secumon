# Headlamp

Install the in-cluster Headlamp dashboard with Helm, then apply the
`secu-agent` namespace viewer RBAC in this folder.

```bash
deploy/k8s/bin/secu-k8s preflight deploy headlamp
deploy/k8s/bin/secu-k8s install-headlamp
deploy/k8s/bin/secu-k8s port-forward headlamp
```

Open `http://localhost:8080` and use the token from:

```bash
kubectl get secret -n secu-agent secu-agent-headlamp-viewer-token \
  -o jsonpath='{.data.token}' | base64 -d
```

The token is namespace-scoped to inspect `secu-agent` pods, services,
deployments, logs, events, configmaps, and PVCs. It intentionally does not
grant Secret read access.
