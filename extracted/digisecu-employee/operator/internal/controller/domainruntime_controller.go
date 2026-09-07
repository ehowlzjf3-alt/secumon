/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	runtimev1alpha1 "github.com/digisecu/operator/api/v1alpha1"
)

const (
	domainFinalizer  = "runtime.digisecu.local/domain-finalizer"
	decommissionAnno = "runtime.digisecu.local/decommission" // "true" 로 명시해야 finalizer가 ns 삭제(blast radius 게이트)
	managedByLabel   = "app.kubernetes.io/managed-by"
	managedByValue   = "digisecu-operator"
	domainLabel      = "runtime.digisecu.local/domain"
	// EmployeeRoleLabel: employee 파드에 붙는 라벨 — egress-allow NetworkPolicy의 셀렉트 대상.
	EmployeeRoleLabel = "runtime.digisecu.local/role"
	EmployeeRoleValue = "employee"
	// RuntimeSAName: 도메인 런타임 ServiceAccount 이름(파드가 이 SA를 쓰되 토큰은 automount false).
	RuntimeSAName   = "de-runtime-sa"
	runtimeRoleName = "de-runtime-role"
	runtimeRBName   = "de-runtime-rb"
	quotaName       = "de-quota"
	limitRangeName  = "de-limits"
	denyAllNP       = "de-deny-all"
	egressAllowNP   = "de-egress-allow"
	domainRequeue   = 2 * time.Minute // 주기적 재확인(drift 교정) — CreateOrUpdate는 무변경 시 no-op
)

// DomainNamespace maps a domain to its isolation namespace name.
// 도메인 값(예: dev_web)의 '_'는 DNS-1123 위반이므로 '-'로 치환(de-domain-dev-web). control-plane과 동일 규칙.
func DomainNamespace(domain string) string {
	return "de-domain-" + strings.ReplaceAll(domain, "_", "-")
}

// DomainRuntimeReconciler reconciles a per-domain isolation namespace + its isolation envelope
// (PodSecurityStandards, minimal RBAC, ResourceQuota/LimitRange, NetworkPolicy egress allowlist).
type DomainRuntimeReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=runtime.digisecu.local,resources=domainruntimes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=runtime.digisecu.local,resources=domainruntimes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=runtime.digisecu.local,resources=domainruntimes/finalizers,verbs=update
// +kubebuilder:rbac:groups=core,resources=namespaces,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=resourcequotas;limitranges,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete

func (r *DomainRuntimeReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var dr runtimev1alpha1.DomainRuntime
	if err := r.Get(ctx, req.NamespacedName, &dr); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	ns := DomainNamespace(dr.Spec.Domain)

	// 1) 삭제 중 → finalizer decommission 게이트. 명시 어노테이션 없으면 ns 삭제 차단(blast radius 방지).
	if !dr.DeletionTimestamp.IsZero() {
		if !controllerutil.ContainsFinalizer(&dr, domainFinalizer) {
			return ctrl.Result{}, nil
		}
		if dr.Annotations[decommissionAnno] != "true" {
			// 명시 decommission 전까지 삭제를 막고(finalizer 유지) 대기 — 실행 중 파드가 있는 ns 무단 삭제 방지.
			_ = r.setStatus(ctx, &dr, "Decommissioning", false, ns, "DecommissionBlocked",
				"명시적 decommission 어노테이션("+decommissionAnno+"=true) 필요")
			return ctrl.Result{}, nil
		}
		var namespace corev1.Namespace
		err := r.Get(ctx, types.NamespacedName{Name: ns}, &namespace)
		if err == nil {
			if namespace.DeletionTimestamp.IsZero() {
				if delErr := r.Delete(ctx, &namespace); delErr != nil && !apierrors.IsNotFound(delErr) {
					return ctrl.Result{}, delErr
				}
			}
			return ctrl.Result{RequeueAfter: requeueWait}, nil // ns 소멸 대기
		} else if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		controllerutil.RemoveFinalizer(&dr, domainFinalizer)
		if err := r.Update(ctx, &dr); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	// 2) finalizer 보장.
	if controllerutil.AddFinalizer(&dr, domainFinalizer) {
		if err := r.Update(ctx, &dr); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	// 3) 격리 리소스 idempotent reconcile. 하나라도 실패하면 isolationReady=false 유지 + 에러(백오프 재큐).
	for _, step := range []struct {
		name string
		fn   func(context.Context, string, string) error
	}{
		{"Namespace", r.ensureNamespace},
		{"ServiceAccount", func(c context.Context, n, _ string) error { return r.ensureServiceAccount(c, n) }},
		{"Role", func(c context.Context, n, _ string) error { return r.ensureRole(c, n) }},
		{"RoleBinding", func(c context.Context, n, _ string) error { return r.ensureRoleBinding(c, n) }},
		{"ResourceQuota", func(c context.Context, n, _ string) error { return r.ensureResourceQuota(c, n) }},
		{"LimitRange", func(c context.Context, n, _ string) error { return r.ensureLimitRange(c, n) }},
		{"NetworkPolicies", func(c context.Context, n, _ string) error { return r.ensureNetworkPolicies(c, n) }},
	} {
		if err := step.fn(ctx, ns, dr.Spec.Domain); err != nil {
			log.Error(err, "격리 리소스 reconcile 실패", "step", step.name, "namespace", ns)
			_ = r.setStatus(ctx, &dr, "Provisioning", false, ns, step.name+"Failed", err.Error())
			return ctrl.Result{}, err
		}
	}

	// 4) 전부 준비 → isolationReady=true. 주기적 재확인으로 drift 교정.
	if err := r.setStatus(ctx, &dr, "Ready", true, ns, "IsolationReady", "격리 리소스 준비 완료"); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: domainRequeue}, nil
}

func (r *DomainRuntimeReconciler) ensureNamespace(ctx context.Context, ns, domain string) error {
	obj := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		if obj.Labels == nil {
			obj.Labels = map[string]string{}
		}
		// PodSecurityStandards restricted 강제(빌트인 PSA, 별도 webhook 불필요).
		obj.Labels["pod-security.kubernetes.io/enforce"] = "restricted"
		obj.Labels["pod-security.kubernetes.io/audit"] = "restricted"
		obj.Labels["pod-security.kubernetes.io/warn"] = "restricted"
		obj.Labels[managedByLabel] = managedByValue
		obj.Labels[domainLabel] = domain
		return nil
	})
	return err
}

func (r *DomainRuntimeReconciler) ensureServiceAccount(ctx context.Context, ns string) error {
	obj := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: RuntimeSAName, Namespace: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		obj.Labels = mergeLabels(obj.Labels, map[string]string{managedByLabel: managedByValue})
		return nil
	})
	return err
}

func (r *DomainRuntimeReconciler) ensureRole(ctx context.Context, ns string) error {
	obj := &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: runtimeRoleName, Namespace: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		obj.Labels = mergeLabels(obj.Labels, map[string]string{managedByLabel: managedByValue})
		// 최소권한: 로그 읽기만(엔진은 k8s API 미사용 — SA 토큰도 automount false).
		obj.Rules = []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"pods/log"}, Verbs: []string{"get"}}}
		return nil
	})
	return err
}

func (r *DomainRuntimeReconciler) ensureRoleBinding(ctx context.Context, ns string) error {
	obj := &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: runtimeRBName, Namespace: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		obj.Labels = mergeLabels(obj.Labels, map[string]string{managedByLabel: managedByValue})
		obj.RoleRef = rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: runtimeRoleName}
		obj.Subjects = []rbacv1.Subject{{Kind: "ServiceAccount", Name: RuntimeSAName, Namespace: ns}}
		return nil
	})
	return err
}

func (r *DomainRuntimeReconciler) ensureResourceQuota(ctx context.Context, ns string) error {
	obj := &corev1.ResourceQuota{ObjectMeta: metav1.ObjectMeta{Name: quotaName, Namespace: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		obj.Labels = mergeLabels(obj.Labels, map[string]string{managedByLabel: managedByValue})
		obj.Spec.Hard = corev1.ResourceList{
			corev1.ResourcePods:           resource.MustParse("20"),
			corev1.ResourceRequestsCPU:    resource.MustParse("4"),
			corev1.ResourceRequestsMemory: resource.MustParse("8Gi"),
			corev1.ResourceLimitsCPU:      resource.MustParse("8"),
			corev1.ResourceLimitsMemory:   resource.MustParse("16Gi"),
		}
		return nil
	})
	return err
}

func (r *DomainRuntimeReconciler) ensureLimitRange(ctx context.Context, ns string) error {
	obj := &corev1.LimitRange{ObjectMeta: metav1.ObjectMeta{Name: limitRangeName, Namespace: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, obj, func() error {
		obj.Labels = mergeLabels(obj.Labels, map[string]string{managedByLabel: managedByValue})
		// Container 단위 기본/상한 — buildPod resourcesFor(50m/64Mi~200m/128Mi)와 정합.
		obj.Spec.Limits = []corev1.LimitRangeItem{{
			Type:           corev1.LimitTypeContainer,
			Default:        corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("200m"), corev1.ResourceMemory: resource.MustParse("128Mi")},
			DefaultRequest: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("50m"), corev1.ResourceMemory: resource.MustParse("64Mi")},
			Max:            corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("2Gi")},
			Min:            corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("32Mi")},
		}}
		return nil
	})
	return err
}

// ensureNetworkPolicies: deny-all(전 파드 ingress+egress 차단) + egress-allow(employee 라벨 파드에 DNS만 허용).
// Gate2에서 egress-allow에 smoke PG(5432)·필요 시 control-plane egress를 추가한다. FQDN(LLM/타깃)은 후순위.
func (r *DomainRuntimeReconciler) ensureNetworkPolicies(ctx context.Context, ns string) error {
	deny := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: denyAllNP, Namespace: ns}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, deny, func() error {
		deny.Labels = mergeLabels(deny.Labels, map[string]string{managedByLabel: managedByValue})
		deny.Spec = networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{}, // 전 파드
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
			// 규칙 없음 → 전부 차단
		}
		return nil
	}); err != nil {
		return err
	}

	udp, tcp := corev1.ProtocolUDP, corev1.ProtocolTCP
	dnsPort := intstr.FromInt32(53)
	allow := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: egressAllowNP, Namespace: ns}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, allow, func() error {
		allow.Labels = mergeLabels(allow.Labels, map[string]string{managedByLabel: managedByValue})
		allow.Spec = networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{EmployeeRoleLabel: EmployeeRoleValue}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress: []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{{
					NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "kube-system"}},
					PodSelector:       &metav1.LabelSelector{MatchLabels: map[string]string{"k8s-app": "kube-dns"}},
				}},
				Ports: []networkingv1.NetworkPolicyPort{
					{Protocol: &udp, Port: &dnsPort},
					{Protocol: &tcp, Port: &dnsPort},
				},
			}},
		}
		return nil
	})
	return err
}

func (r *DomainRuntimeReconciler) setStatus(
	ctx context.Context, dr *runtimev1alpha1.DomainRuntime,
	phase string, ready bool, ns, reason, msg string,
) error {
	orig := dr.DeepCopy()
	dr.Status.Phase = phase
	dr.Status.IsolationReady = ready
	dr.Status.Namespace = ns
	dr.Status.ObservedGeneration = dr.Generation
	meta.SetStatusCondition(&dr.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: boolCond(ready), Reason: nonEmpty(reason, "Reconciled"), Message: msg, ObservedGeneration: dr.Generation,
	})
	if equality.Semantic.DeepEqual(orig.Status, dr.Status) {
		return nil
	}
	return r.Status().Update(ctx, dr)
}

func mergeLabels(existing, add map[string]string) map[string]string {
	if existing == nil {
		existing = map[string]string{}
	}
	for k, v := range add {
		existing[k] = v
	}
	return existing
}

// SetupWithManager sets up the controller with the Manager.
func (r *DomainRuntimeReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&runtimev1alpha1.DomainRuntime{}).
		Named("domainruntime").
		Complete(r)
}
