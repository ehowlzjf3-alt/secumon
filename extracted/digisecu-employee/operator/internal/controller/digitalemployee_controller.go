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
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	runtimev1alpha1 "github.com/digisecu/operator/api/v1alpha1"
)

const (
	finalizerName = "runtime.digisecu.local/finalizer"
	uid10001      = int64(10001)
	requeueWait   = 2 * time.Second
)

// DigitalEmployeeReconciler reconciles a DigitalEmployee object.
// It reconciles infrastructure only (a single backing Pod) toward spec.desired; the state-machine
// authority and all domain/§6 safety live in control-plane / the engine (out of scope here).
type DigitalEmployeeReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=runtime.digisecu.local,resources=digitalemployees,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=runtime.digisecu.local,resources=digitalemployees/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=runtime.digisecu.local,resources=digitalemployees/finalizers,verbs=update
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch;create;delete

func (r *DigitalEmployeeReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var de runtimev1alpha1.DigitalEmployee
	if err := r.Get(ctx, req.NamespacedName, &de); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	podName := "de-" + de.Name
	var pod corev1.Pod
	podErr := r.Get(ctx, types.NamespacedName{Namespace: de.Namespace, Name: podName}, &pod)
	if podErr != nil && !apierrors.IsNotFound(podErr) {
		return ctrl.Result{}, podErr
	}
	podExists := podErr == nil
	podDeleting := podExists && !pod.DeletionTimestamp.IsZero()

	// 1) CR being deleted → finalizer drain (never create a pod on a deleting CR).
	if !de.DeletionTimestamp.IsZero() {
		if podExists {
			if !podDeleting {
				if err := r.Delete(ctx, &pod); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
			return r.applyStatus(ctx, &de, "Draining", podRefOf(&pod), false, true, "Deleting", "draining pod before CR deletion")
		}
		if controllerutil.RemoveFinalizer(&de, finalizerName) {
			if err := r.Update(ctx, &de); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	// 2) ensure finalizer.
	if controllerutil.AddFinalizer(&de, finalizerName) {
		if err := r.Update(ctx, &de); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	// 3) desired Paused / Terminated → scale to zero (delete pod). CR remains.
	if de.Spec.Desired == "Paused" || de.Spec.Desired == "Terminated" {
		if podExists {
			if !podDeleting {
				if err := r.Delete(ctx, &pod); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
			return r.applyStatus(ctx, &de, "Draining", podRefOf(&pod), false, true, "Stopping", "stopping pod")
		}
		if de.Spec.Desired == "Terminated" {
			return r.applyStatus(ctx, &de, "Terminated", nil, false, false, "Terminated", "no pod; terminated")
		}
		return r.applyStatus(ctx, &de, "Paused", nil, false, false, "Paused", "no pod; paused")
	}

	// 4) desired Running → ensure exactly one fresh pod.
	if podDeleting {
		// Prior pod still terminating; wait for full 404 before creating a new one (at-most-one).
		return r.applyStatus(ctx, &de, "Provisioning", podRefOf(&pod), false, true, "AwaitingCleanup", "waiting for prior pod termination")
	}
	if !podExists {
		newPod := r.buildPod(&de, podName)
		if err := controllerutil.SetControllerReference(&de, newPod, r.Scheme); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.Create(ctx, newPod); err != nil {
			if apierrors.IsAlreadyExists(err) {
				return ctrl.Result{Requeue: true}, nil
			}
			log.Error(err, "pod create failed")
			return r.applyStatus(ctx, &de, "Unhealthy", nil, false, false, "PodCreateFailed", err.Error())
		}
		return r.applyStatus(ctx, &de, "Provisioning", &runtimev1alpha1.PodRef{Name: newPod.Name, UID: string(newPod.UID)}, false, true, "PodCreated", "pod created")
	}
	phase, reason := mapRunningPhase(&pod)
	return r.applyStatus(ctx, &de, phase, podRefOf(&pod), phase == "Running", phase == "Provisioning", reason, "")
}

// mapRunningPhase maps a backing pod (under desired=Running) to an observed phase. Deterministic per codex table:
// container-level failures (CrashLoop/image/config) → Unhealthy; PodFailed/Unknown/Succeeded → Unhealthy;
// Running+Ready → Running; otherwise (Pending / running-not-ready) → Provisioning.
func mapRunningPhase(pod *corev1.Pod) (string, string) {
	for _, cs := range pod.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil {
			switch w.Reason {
			case "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "InvalidImageName", "CreateContainerError":
				return "Unhealthy", w.Reason
			}
		}
	}
	switch pod.Status.Phase {
	case corev1.PodFailed, corev1.PodUnknown:
		return "Unhealthy", "PodFailed"
	case corev1.PodSucceeded:
		return "Unhealthy", "PodExited" // a long-running employee pod should not exit
	case corev1.PodRunning:
		if podReady(pod) {
			return "Running", "PodReady"
		}
		return "Provisioning", "PodNotReady"
	default:
		return "Provisioning", "PodPending"
	}
}

func podReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func podRefOf(pod *corev1.Pod) *runtimev1alpha1.PodRef {
	if pod == nil || pod.Name == "" {
		return nil
	}
	return &runtimev1alpha1.PodRef{Name: pod.Name, UID: string(pod.UID)}
}

// applyStatus sets phase/podRef/observedGeneration + Ready/Progressing conditions, patches status
// only on meaningful change (avoid hot-loop), and requeues while transitional (Provisioning/Draining).
func (r *DigitalEmployeeReconciler) applyStatus(
	ctx context.Context, de *runtimev1alpha1.DigitalEmployee,
	phase string, podRef *runtimev1alpha1.PodRef, ready, progressing bool, reason, msg string,
) (ctrl.Result, error) {
	orig := de.DeepCopy()
	de.Status.Phase = phase
	de.Status.ObservedGeneration = de.Generation
	de.Status.PodRef = podRef
	meta.SetStatusCondition(&de.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: boolCond(ready), Reason: nonEmpty(reason, "Reconciled"), Message: msg, ObservedGeneration: de.Generation,
	})
	meta.SetStatusCondition(&de.Status.Conditions, metav1.Condition{
		Type: "Progressing", Status: boolCond(progressing), Reason: nonEmpty(reason, "Reconciled"), Message: msg, ObservedGeneration: de.Generation,
	})
	if !equality.Semantic.DeepEqual(orig.Status, de.Status) {
		if err := r.Status().Update(ctx, de); err != nil {
			return ctrl.Result{}, err
		}
	}
	if phase == "Provisioning" || phase == "Draining" {
		return ctrl.Result{RequeueAfter: requeueWait}, nil
	}
	return ctrl.Result{}, nil
}

// buildPod constructs the hardened idle backing pod (M3.1: lifecycle-only, pinned pause image).
func (r *DigitalEmployeeReconciler) buildPod(de *runtimev1alpha1.DigitalEmployee, name string) *corev1.Pod {
	nonRoot, roFS, noEsc := true, true, false
	uid := uid10001
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: de.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by":       "digisecu-operator",
				"runtime.digisecu.local/employee-id": de.Spec.EmployeeID,
				EmployeeRoleLabel:                    EmployeeRoleValue, // M3.3a: egress-allow NetworkPolicy 셀렉트 대상
			},
		},
		Spec: corev1.PodSpec{
			ServiceAccountName:           RuntimeSAName, // M3.3a: 도메인 런타임 SA(최소권한). 토큰은 automount false로 미탑재.
			AutomountServiceAccountToken: &noEsc,        // false — no SA token mount
			SecurityContext: &corev1.PodSecurityContext{
				RunAsNonRoot:   &nonRoot,
				RunAsUser:      &uid,
				RunAsGroup:     &uid,
				FSGroup:        &uid,
				SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
			},
			Containers: []corev1.Container{{
				Name:      "runtime",
				Image:     de.Spec.Image,
				Resources: r.resourcesFor(de),
				SecurityContext: &corev1.SecurityContext{
					RunAsNonRoot:             &nonRoot,
					RunAsUser:                &uid,
					ReadOnlyRootFilesystem:   &roFS,
					AllowPrivilegeEscalation: &noEsc,
					Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
					SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
				},
			}},
			RestartPolicy: corev1.RestartPolicyAlways,
		},
	}
}

func (r *DigitalEmployeeReconciler) resourcesFor(de *runtimev1alpha1.DigitalEmployee) corev1.ResourceRequirements {
	if de.Spec.Resources != nil {
		return *de.Spec.Resources
	}
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("50m"), corev1.ResourceMemory: resource.MustParse("64Mi")},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("200m"), corev1.ResourceMemory: resource.MustParse("128Mi")},
	}
}

func boolCond(b bool) metav1.ConditionStatus {
	if b {
		return metav1.ConditionTrue
	}
	return metav1.ConditionFalse
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// SetupWithManager sets up the controller with the Manager.
func (r *DigitalEmployeeReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&runtimev1alpha1.DigitalEmployee{}).
		Owns(&corev1.Pod{}).
		Named("digitalemployee").
		Complete(r)
}
