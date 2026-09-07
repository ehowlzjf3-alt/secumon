# k3s 셋업 & 운영 교훈 (VulnerManage 이관 경험 정리)

> 출처: VulnerManage(취약점 관리 시스템)를 pm2 모놀리식 → **k3s 단일 노드**로 이관하면서 부딪힌 실전 문제들.
> **⚠️ 이 문서를 secu-agent-skill(비폐쇄망)에 맞춰 정리함.** VulnerManage는 폐쇄망이라 인터넷/사설 레지스트리/사내 CA/프록시 관련 삽질이 많았는데, **secu-agent는 폐쇄망이 아니므로 그 부분은 대부분 스킵 가능**하다. 그런 항목은 §10에 "폐쇄망 전용(여기선 불필요)"로 따로 모아뒀다. §1~§9는 환경 무관하게 유효하다.

---

## 1. ⚠️ 1순위 함정 — traefik + servicelb가 노드 포트(80/443)를 가로챈다

k3s는 기본으로 **traefik**(Ingress 컨트롤러)과 **servicelb(klipper-lb)**를 깐다. traefik 서비스는 `type: LoadBalancer`인데, 온프렘엔 클라우드 LB가 없으니 **servicelb가 대타로 노드의 80/443을 iptables(hostPort)로 잡는다.**

- **증상**: 기존에 노드 80/443을 쓰던 서비스(예: 호스트 nginx)가 갑자기 404. `ss -tlnp`엔 nginx가 443 listen인데도 트래픽이 안 닿음 → **iptables PREROUTING DNAT가 소켓 앞에서 채감.**
- **핵심 이해**: servicelb는 **`type: LoadBalancer` 서비스가 있으면** 그 서비스마다 `svclb-<name>` DaemonSet을 띄워 노드 포트를 잡는다. traefik이 LoadBalancer라서 딸려 나온다.
- **해결 (택1, 상황에 맞게)**:
  - **자체 Ingress/외부 LB를 앞단에 둘 거면**: `--disable servicelb` (그리고 필요시 `--disable traefik`). 이게 표준.
  - traefik은 쓰되 포트만 고정하려면 `HelmChartConfig`로 NodePort 지정. **단 차트 버전에 따라 `service.type`을 무시할 수 있음**(우리가 겪음 — v40 traefik) → 그럴 땐 포트 고정과 싸우지 말고 `--disable servicelb`로 근본 제거가 낫다.
- **config.yaml (`/etc/rancher/k3s/config.yaml`) 예시** — 여기엔 "추가할 플래그"만 적으면 systemd unit과 병합됨:
  ```yaml
  disable:
    - servicelb
    # - traefik        # 자체 ingress 쓸 거면
  ```
  변경 후 `sudo systemctl restart k3s`.

### 1-b. servicelb는 traefik 말고 **아무 LoadBalancer 서비스**나 하이재킹한다
실제 사고: 로컬 k3s에 `numbers-web`(LoadBalancer, :8080)이 떠 있었는데, 그 `svclb-numbers-web` 파드가 **노드 0.0.0.0:8080을 hostPort로 잡아** 같은 포트를 쓰던 다른 프로세스(우리 MCP)를 가로챘다. 루프백(127.0.0.1:8080)까지 그 파드로 갔다.
- **진단**: `curl http://<node-ip>:<port>/` 응답이 기대한 앱이 아니라 엉뚱한 앱 → `kubectl get svc -A | grep <port>`로 LoadBalancer 서비스 찾기 + `kubectl get pods -n kube-system | grep svclb`.
- **복구**: 그 서비스를 `ClusterIP`로 내리면 svclb 종료 → 포트 해방:
  ```bash
  kubectl -n <ns> patch svc <name> -p '{"spec":{"type":"ClusterIP"}}'
  ```
- **교훈**: **공유 노드에서 LoadBalancer 타입 서비스는 노드 포트를 잠재적으로 훔친다.** 꼭 필요할 때만 쓰고, 아니면 ClusterIP/NodePort.

---

## 2. 비루트 하드닝 (securityContext)

컨테이너는 기본적으로 비루트로 돌려라. 파드 spec에:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000          # ★ 반드시 "숫자" UID
  runAsGroup: 1000
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
```

- **함정: `runAsNonRoot: true` + 이미지 `USER 이름`(예: `USER node`)** → `CreateContainerConfigError: image has non-numeric user (node), cannot verify user is non-root`. k8s는 이미지의 `/etc/passwd`를 안 뒤지므로 **숫자 `runAsUser`가 반드시 필요**하다.
- **nginx 정적 서빙 비루트화**: stock `nginx:alpine`은 root로 :80 바인딩. → **`nginxinc/nginx-unprivileged`**(uid 101, **8080** 리슨) 이미지로 교체:
  - nginx.conf `listen 80;` → `listen 8080;`
  - Deployment: `securityContext`(runAsUser 101) + `containerPort: 8080` + probe port 8080
  - **Service는 `port: 80` 유지(Ingress용), `targetPort: 8080`만 변경** → Ingress→Service:80→pod:8080
- **postgres 등 볼륨 쓰는 파드**: `securityContext.fsGroup: 999`(postgres 유저 gid)로 마운트 볼륨 쓰기 권한. 비루트 컨테이너 표준.

---

## 3. GitOps (Argo CD) 운영 교훈

- **Synced ≠ Healthy** — 완전 별개 축.
  - **Sync** = git 매니페스트 == 클러스터 (배포됐나)
  - **Health** = 리소스가 실제 동작 상태냐
  - `Synced`인데 `Progressing` 무한 → 리소스가 죽은 게 아니라 **Argo의 health 기준이 내 인프라와 안 맞는 것**일 수 있다.
- **Ingress health 함정**: Argo 기본 Ingress health는 `.status.loadBalancer`에 주소가 찍혀야 Healthy로 본다. **외부 LB(nginx 등)를 앞단에 두면** LB 주소가 안 찍혀서 영원히 Progressing. → argocd-cm에 `resource.customizations.health` Lua 오버라이드로 "Ingress는 존재하면 Healthy" 재정의.
- **DB 마이그레이션은 PreSync 훅으로**: `argocd.argoproj.io/hook: PreSync` Job → 앱 sync 전에 스키마 먼저 맞춤. `hook-delete-policy: BeforeHookCreation`(다음 실행 때 이전 Job 삭제).
- **훅만 바꾸면 자동 sync 안 뜬다**: tracked 리소스가 안 변하면 Argo가 sync를 안 돌림(훅은 sync 중에만 실행). → 강제 sync:
  ```bash
  kubectl -n argocd patch application <app> --type merge -p '{"operation":{"sync":{}}}'
  ```
  근데 이건 리소스 변경이 있어야 훅이 돈다. 검증만 하려면 **일회성 Job을 따로 apply**하는 게 확실.
- **imperative `kubectl patch`는 selfHeal에 되돌아간다**: automated prune/selfHeal 켜면 손으로 바꾼 tracked 리소스가 git 상태로 복원됨. **영구 변경은 git(매니페스트)에.** (동적 프로비저닝 PV처럼 매니페스트 없는 리소스만 patch가 유지됨.)
- **배포 브랜치 규율**: `main`을 Argo가 감시(prune/selfHeal) → main에 push=즉시 프로덕션. 기능개발은 feature 브랜치 → 검증 후 머지.

---

## 4. DB 운영 (Postgres)

### 4-a. prisma migrate 도입 (db push 탈피)
`db push`는 이력이 없어 운영에 불안. 기존 DB(db push로 스키마 반영됨)를 **versioned migrate로 baseline 편입**:
```bash
# 1) 현재 스키마 전체를 초기 마이그레이션으로 (오프라인, DB 불필요)
npx prisma migrate diff --from-empty --to-schema-datamodel ./prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql
#    + prisma/migrations/migration_lock.toml (provider = "postgresql")
# 2) 프로덕션 DB baseline — SQL 실행 없이 "이미 적용됨"으로만 기록 (저위험)
npx prisma migrate resolve --applied 0_init
# 3) 배포 훅/Job의 명령을 db push → migrate deploy 로 교체
#    이후: 로컬 migrate dev --name xxx → 이미지 태그 bump → git push → 훅이 migrate deploy
```
**순서 중요**: baseline을 **훅 전환 전에** 해야 한다. 안 그러면 `migrate deploy`가 0_init을 실행하려다 "테이블 이미 존재"로 실패.

### 4-b. 백업 / DR
단일 노드 PVC(`local-path`, reclaim `Delete`)는 노드/PVC 삭제 시 데이터 전멸. 최소 3종:
1. **정기 백업 CronJob** — `pg_dump | gzip`을 **컨테이너 안에서** 실행(호스트 셸 제약 우회). non-root, `timeZone: Asia/Seoul`, N일 로테이션. 저장은 **off-node(NFS)면 진짜 DR**, hostPath면 PVC 삭제만 방어(노드 사망엔 취약).
2. **PV reclaimPolicy `Delete`→`Retain`**: `kubectl patch pv <name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'` (동적 PV라 imperative가 맞음).
3. **복구 리허설** — *복구 안 해본 백업은 백업이 아니다.* 덤프를 **임시 DB에 복원 → 행수 검증 → drop**하는 일회성 Job. 프로덕션은 안 건드림.
- 참고: `local-path` StorageClass는 **동적 프로비저닝**이라 PV 정의 없이 PVC가 Bound된다.

---

## 5. Secret at-rest 암호화 (k3s)

k8s Secret 기본은 **base64(암호화 아님)** — datastore(etcd/SQLite `state.db`) 읽으면 그대로 디코딩됨.
- **⚠️ config 플래그가 아니라 CLI 명령이다** (최신 k3s v1.36 기준): config.yaml에 `secret-encryption: true` 넣으면 로그에 `Unknown flag ... skipping`으로 무시되고 오히려 재조정을 방해한다. **넣지 마라.**
  ```bash
  sudo k3s secrets-encrypt enable
  sudo systemctl restart k3s
  sudo k3s secrets-encrypt status          # "Encryption Status: Enabled" 확인
  sudo k3s secrets-encrypt reencrypt        # 기존 Secret 재암호화
  ```
- **암호화 키 백업 필수**: `/var/lib/rancher/k3s/server/cred/encryption-config.json` — 유실 시 암호화된 Secret 복구 불가.
- **겪은 함정**: 특정 설치에선 `enable` 후에도 restart마다 `Disabled, no configuration file found`로 초기화(`Unable to lookup path to reconcile EncryptionConfig`). 이러면 데이터디렉토리/버전 이슈 조사하거나, k3s CLI 대신 **kube-apiserver에 직접 `--kube-apiserver-arg=encryption-provider-config=<파일>`로 수동 EncryptionConfiguration** 지정하는 우회가 있다. 프로덕션에서 restart 반복은 신중히.

---

## 6. Graceful shutdown / drain

k8s는 종료 시 SIGTERM → grace period 내 정리를 기대. 앱(특히 백그라운드 워커)은:
- SIGTERM 핸들러: **새 연결 거절(server.close) → 진행 중 작업 drain → DB 커넥션 정리 → exit.**
- **cron 워커 drain**: 종료 플래그(`draining`)로 새 틱은 skip, **진행 중인 틱은 안전지점까지 완료 대기**(in-flight 카운터 + `waitForDrain(timeout)`). 안 그러면 종료 중 데이터 반쪽 갱신.
- `terminationGracePeriodSeconds`를 작업 특성에 맞게(워커는 길게, 예 120s). drain 대기 타임아웃은 그 안으로.
- **preStop `sleep 5`**: SIGTERM 전에 Endpoint 전파를 기다려 라우팅 레이스 완화(트래픽 받는 파드).

---

## 7. 관측성 (모니터링 · 로그 · 알림)

k3s는 **metrics-server를 기본 탑재** → `kubectl top`이 바로 된다.

### 리소스 모니터링
```bash
kubectl top nodes
kubectl top pods -A --sort-by=memory
```
- 소형 노드는 RAM이 빡빡하니 **requests/limits를 꼭 설정**하고 실제 사용량을 보며 튜닝. limit이 낮으면 `OOMKilled`, request가 높으면 `Pending`.

### kubectl로 1차 감지하는 이상 신호
| 상태 | 의미 / 조치 |
|------|------------|
| `OOMKilled` | 메모리 limit 초과 → limit 상향 or 누수 점검 (`kubectl get events -A --field-selector reason=OOMKilling`) |
| `Pending` | 스케줄 불가(리소스 부족·nodeSelector·PVC 미바인딩) → `kubectl describe pod` |
| `CrashLoopBackOff` | 계속 죽음 → `kubectl logs <pod> --previous` |
| `ImagePullBackOff` | 이미지 pull 실패(태그·인증·레지스트리) |
| `Evicted` | 노드 리소스 압박(disk/mem) |
```bash
kubectl get events -A --sort-by=.lastTimestamp | tail -30   # 최근 이벤트 흐름
```

### 로그
- 기본: `kubectl logs -f deploy/<x>`, `kubectl logs <pod> --previous`(크래시 직전).
- **중앙 수집(규모 커지면)**: **Grafana Loki + Promtail**(경량, 파드 stdout 수집) 권장. 소형 노드엔 Loki가 Elastic(EFK)보다 가볍다.
- 앱은 **stdout에 구조화 로그(JSON)** 로 뿌려라(파일 로그 X) → 수집·검색 쉬움.

### 메트릭 스택 (본격 모니터링)
- **kube-prometheus-stack**(Prometheus + Grafana + Alertmanager) 헬름 차트가 표준. 노드/파드/컨테이너 메트릭 + 대시보드 + 알림 한 번에:
  ```bash
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm install kps prometheus-community/kube-prometheus-stack -n monitoring --create-namespace
  ```
  - ⚠️ **소형 노드엔 무겁다**(Prometheus 수백 MB~). RAM 여유 없으면 retention/scrape interval 축소하거나, 가벼운 대안(`metrics-server` + `kubectl top` + 간단 알림 스크립트)으로.
  - 비폐쇄망이라 차트·이미지 pull은 문제 없음.

### 알림
- **Alertmanager**(kube-prometheus-stack 포함)로 OOM/Pending/재시작/노드 Down → Slack·메일·웹훅.
- 가벼운 대안: cron으로 `kubectl get pods -A`에서 비정상 상태(CrashLoop/Pending/OOM) 감지 → 웹훅/메일.
- ※ **인프라 알림 ≠ 앱 알림**: 위는 클러스터/리소스 관측성. 앱 레벨 실패(외부 API 연동 등)는 앱에서 따로 잡는 게 낫다.

### probe = 관측성의 1차 방어선
- `readinessProbe`(트래픽 받을 준비) / `livenessProbe`(죽으면 재시작)를 꼭 설정. 헬스체크가 곧 **자동복구 + 상태 가시성**.

---

## 8. 빠른 진단 치트시트

| 증상 | 확인 | 원인/조치 |
|------|------|-----------|
| 노드 포트로 엉뚱한 앱 응답 | `kubectl get svc -A \| grep <port>` + `get pods -n kube-system \| grep svclb` | servicelb 하이재킹 → 서비스 ClusterIP로 |
| `CreateContainerConfigError` non-numeric user | 이미지 USER가 이름 | `runAsUser: <숫자>` |
| Argo `Synced`인데 `Progressing` | `kubectl get ingress <x> -o jsonpath='{.status.loadBalancer}'` = `{}` | Ingress health 오버라이드(외부 LB 시) |
| PreSync 훅이 안 돎 | tracked 리소스 diff 없음 | force sync 또는 일회성 Job |
| PVC가 PV 없이 Bound | `local-path` StorageClass | 동적 프로비저닝(정상) |
| secret-encrypt restart마다 초기화 | 로그 `Unable to lookup path to reconcile EncryptionConfig` | config 플래그 제거, CLI enable, 또는 kube-apiserver-arg 수동 |

---

## 9. 기타 잡다 (작지만 유용)

- **`sudo k3s kubectl`이 기본** — `~/.kube/config`로 복사 + `export KUBECONFIG`하면 sudo 없이. k3s kubeconfig는 root 전용(`/etc/rancher/k3s/k3s.yaml`).
- **`kubectl delete pod`는 Argo와 안 싸운다**(파드는 tracked 아님) — configmap 반영용 재시작에 `rollout restart`(annotation drift로 selfHeal이 되돌릴 수 있음)보다 파드 delete가 깔끔할 때가 있다.
- **configmap 바꿔도 파드 자동 재시작 안 됨**(env는 파드 기동 시 1회 주입). 재시작 트리거하려면 Deployment 템플릿에 `config-rev` 같은 annotation을 두고 configmap 바꿀 때 같이 bump → Argo가 자동 롤링.
- **`401`은 실패 아님**(레지스트리/서비스가 "정상, 인증 필요"). `403 차단페이지`가 진짜 실패.

---

## 10. 폐쇄망 전용 (secu-agent엔 **불필요** — 참고만)

VulnerManage가 폐쇄망이라 필요했던 것들. secu-agent는 인터넷이 되므로 대부분 스킵:
- **사설 레지스트리 + `--system-default-registry`**: 폐쇄망은 이미지를 사내 Harbor로 밀고 k3s 시스템 이미지도 거기서 당김. 비폐쇄망은 공용 레지스트리(docker.io 등) 직접 pull 가능 → 불필요.
- **`/etc/rancher/k3s/registries.yaml`**(mirror/auth/CA): 사설 레지스트리 인증·CA 신뢰용. 공용 레지스트리면 불필요. (사설 레지스트리를 정식 인증서로 쓰면 `insecure_skip_verify` 대신 시스템 신뢰스토어에 CA 등록 + `ca_file`.)
- **레지스트리 robot account**: 개인 계정 대신 봇 계정으로 push/pull. SSO 붙은 레지스트리에서 CLI/containerd가 개인 토큰 못 쓸 때. (일반적으로도 CI엔 권장이지만 필수는 아님)
- **프록시 TLS 인스펙션 우회**: 빌드 시 `npm config set strict-ssl false`, 런타임 `NODE_TLS_REJECT_UNAUTHORIZED=0` / `NODE_EXTRA_CA_CERTS`, systemd/파드에서 외부 fetch 시 `HTTP(S)_PROXY` env. **비폐쇄망은 프록시 TLS 인스펙션이 없으면 다 불필요.** (systemd 서비스는 셸 env를 상속 안 하니 프록시가 필요하면 unit에 `Environment=HTTP(S)_PROXY=` 명시해야 하는 건 폐쇄망 무관하게 알아둘 것.)
- **외부 인터넷 차단(엔드포인트 보안/방화벽)**: 리눅스 박스는 에이전트 미설치라 외부 접속이 정책상 막힐 수 있음(출발지 IP 화이트리스트/필터 예외 필요). 비폐쇄망 일반 서버면 해당 없음.
- **git=텍스트/레지스트리=이미지 채널 분리**: 호스트 간 파일 전송이 다 막힌 폐쇄망 대응. 비폐쇄망은 scp/직접전송 가능.
- **빌드 함정(폐쇄망에서 자주 밟음)**:
  - Dockerfile `COPY`는 **인라인 주석(`#`)을 지원 안 함** → `#` 뒤 단어가 소스파일 인자로 파싱돼 실패. 주석은 윗줄로.
  - npm peer 충돌(예: React 19 vs 구 lib) → `npm ci --legacy-peer-deps`.
  - `package.json`에서 deps 빼면 **`package-lock.json`도 동기화**(`npm install --package-lock-only`)해야 `npm ci` 안 깨짐.
  - 셸 가드(명령 체이닝·특정 바이너리 차단) 있으면 파이프/`&&` 없이 단일 명령, `pg_dump` 등은 k8s Job 안에서.

---

*(원본 상세: VulnerManage repo `docs/k8s-migration-issues.md`(12개 이슈 증상→원인→해결), `docs/k8s-hardening-todo.md`(하드닝 항목별 실행 기록).)*
