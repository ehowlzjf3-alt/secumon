# secu-agent-skill Kubernetes deployment

This directory makes each runnable domain visible as an independent Kubernetes
folder while preserving the repository boundary:

- `base/` owns namespace, runtime env, service account, and shared evidence PVC.
- `domains/smb/` runs SMB web, collector, task, report-mail, and reply/reverify.
- `domains/dev-web/` runs dev_web web plus discovery/task/report/reverify agents.
- `domains/github/` runs GitHub web plus the GitHub pipeline runner.
- `domains/confluence/` runs Confluence web plus the Confluence pipeline runner.
- `domains/jenkins/` records the current plugin-only status. Jenkins has tools
  and skill content but no dedicated queue/runner/webapp yet.
- `overlays/all/` renders every current domain together.
- `overlays/kind/` renders every current domain plus a local Postgres and
  non-production runtime Secret for a disposable kind smoke test.
- `addons/headlamp/`, `addons/kubeshark/`, and `../k9s/` provide visualization
  setup.

## Build the image

The image needs both this skill repo and the de-domain engine repo.

```bash
cd /home/shaneee.baek/project/secu-agent-skill
deploy/k8s/bin/secu-k8s preflight local all
deploy/k8s/bin/secu-k8s build-image
```

`SECU_K8S_IMAGE` changes the image used by `build-image`, `load-image`,
`render`, and `apply`:

```bash
SECU_K8S_IMAGE=registry.example/secu-agent-skill:2026-07-07 \
  deploy/k8s/bin/secu-k8s render all >/tmp/secu-agent-all.yaml
```

If the build runs behind a TLS-inspecting proxy or internal package mirror,
pass pip settings through the build script instead of editing the Dockerfile:

```bash
SECU_PIP_TRUSTED_HOST="pypi.org files.pythonhosted.org" \
  deploy/k8s/bin/secu-k8s build-image
```

`SECU_PIP_INDEX_URL` and `SECU_PIP_CERT` are also forwarded as Docker build
arguments when set.

For kind/minikube, load the image into the local cluster after building.

```bash
deploy/k8s/bin/secu-k8s load-image kind
# or: deploy/k8s/bin/secu-k8s load-image minikube
```

`load-image kind` also loads the Postgres, Headlamp, and Kubeshark images when
they exist locally. This is useful when the cluster cannot pull images directly
because of corporate CA or registry policy. The defaults are:

- `SECU_K8S_POSTGRES_IMAGE=postgres:16-bookworm`
- `SECU_HEADLAMP_IMAGE=ghcr.io/headlamp-k8s/headlamp:v0.43.0`
- `SECU_KUBESHARK_FRONT_IMAGE=docker.io/kubeshark/front:v53.3`
- `SECU_KUBESHARK_HUB_IMAGE=docker.io/kubeshark/hub:v53.3`
- `SECU_KUBESHARK_WORKER_IMAGE=docker.io/kubeshark/worker:v53.3`

## Configure runtime secrets

Create a real secret from `base/runtime-secret.example.yaml`. Do not apply the
example file as-is because it contains placeholder values.

```bash
deploy/k8s/bin/secu-k8s apply base
cp deploy/k8s/base/runtime-secret.example.yaml /tmp/secu-agent-runtime-secret.yaml
$EDITOR /tmp/secu-agent-runtime-secret.yaml
kubectl apply -f /tmp/secu-agent-runtime-secret.yaml
```

The engine reads PostgreSQL from `SECU_AGENT_PG_DSN`.

Keep delivery dry-run unless an operator intentionally configures all core
delivery opt-in gates. The base ConfigMap sets:

- `SA_DELIVERY_AUTOSEND_SINKS=""`
- `SA_DELIVERY_AUTOSEND_CHARTERS=""`
- `SA_DELIVERY_RECIPIENT_ALLOW=""`
- `SMB_REMEDIATION_MAIL_MODE=dssoc_only`

## Deploy

Deploy everything:

```bash
deploy/k8s/bin/secu-k8s preflight deploy all
deploy/k8s/bin/secu-k8s apply all
deploy/k8s/bin/secu-k8s wait all
```

For a disposable local kind smoke test, use the `kind` overlay. It includes an
in-cluster Postgres and placeholder tokens so workloads can boot without real
internal credentials.

```bash
export KUBECONFIG=/tmp/secu-agent-kind-kubeconfig
kind create cluster --name secu-agent
deploy/k8s/bin/secu-k8s load-image kind
deploy/k8s/bin/secu-k8s apply kind
deploy/k8s/bin/secu-k8s wait kind
deploy/k8s/bin/secu-k8s status
```

Or deploy one domain after the base:

```bash
deploy/k8s/bin/secu-k8s apply base
deploy/k8s/bin/secu-k8s apply smb
deploy/k8s/bin/secu-k8s apply dev-web
deploy/k8s/bin/secu-k8s apply github
deploy/k8s/bin/secu-k8s apply confluence
```

Jenkins is intentionally plugin-only for now:

```bash
deploy/k8s/bin/secu-k8s apply jenkins
```

## Open dashboards

```bash
deploy/k8s/bin/secu-k8s port-forward smb
deploy/k8s/bin/secu-k8s port-forward dev-web
deploy/k8s/bin/secu-k8s port-forward github
deploy/k8s/bin/secu-k8s port-forward confluence
```

Headlamp:

```bash
deploy/k8s/bin/secu-k8s preflight deploy headlamp
docker pull ghcr.io/headlamp-k8s/headlamp:v0.43.0
deploy/k8s/bin/secu-k8s load-image kind
deploy/k8s/bin/secu-k8s install-headlamp
deploy/k8s/bin/secu-k8s port-forward headlamp
```

Kubeshark:

```bash
deploy/k8s/bin/secu-k8s preflight deploy kubeshark
docker pull docker.io/kubeshark/front:v53.3
docker pull docker.io/kubeshark/hub:v53.3
docker pull docker.io/kubeshark/worker:v53.3
deploy/k8s/bin/secu-k8s load-image kind
deploy/k8s/bin/secu-k8s install-kubeshark
deploy/k8s/bin/secu-k8s port-forward kubeshark
```

`install-kubeshark` sets `tap.docker.imagePullPolicy=IfNotPresent`, disables
Kubeshark telemetry/cloud-license UI for local smoke tests, and delays the hub
probe so startup is not killed while external cloud checks time out.

K9s:

```bash
deploy/k8s/bin/secu-k8s k9s
```

Official references used for the add-on commands:

- Headlamp in-cluster install: https://headlamp.dev/docs/latest/installation/in-cluster/
- Kubeshark install: https://docs.kubeshark.com/en/install/
- K9s install/config: https://k9scli.io/topics/install/ and https://k9scli.io/topics/config/

## Verify manifests

```bash
deploy/k8s/bin/secu-k8s preflight local all
deploy/k8s/bin/secu-k8s render kind >/tmp/secu-agent-kind.yaml
deploy/k8s/bin/secu-k8s render all >/tmp/secu-agent-all.yaml
deploy/k8s/bin/secu-k8s render headlamp >/tmp/secu-agent-headlamp-rbac.yaml
bash -n deploy/k8s/bin/secu-k8s
```

These commands only render manifests; they do not contact the cluster.
`preflight deploy` also checks cluster reachability, the local image, and the
runtime Secret, so it should fail loudly until kubeconfig access, image loading,
and real runtime credentials are ready.
