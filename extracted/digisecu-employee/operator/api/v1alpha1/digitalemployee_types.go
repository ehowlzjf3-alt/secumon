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

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// DigitalEmployeeSpec defines the desired runtime state of a DigitalEmployee.
//
// The control-plane owns the state machine and writes this spec; the operator only
// reconciles infrastructure (Pod) toward it. Domain/persona/budget and §6 safety are
// owned by the engine (out of scope here) — added later via a runtimeConfigRef.
//
// +kubebuilder:validation:XValidation:rule="!(oldSelf.desired == 'Terminated' && self.desired != 'Terminated')",message="cannot transition out of Terminated"
type DigitalEmployeeSpec struct {
	// employeeId is the control-plane UUID for this employee. Immutable.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=200
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="employeeId is immutable"
	EmployeeID string `json:"employeeId"`

	// desired is the intended runtime state. control-plane sets this; operator converges observed phase.
	// +kubebuilder:validation:Enum=Running;Paused;Terminated
	Desired string `json:"desired"`

	// image is the pod container image. M3.1 defaults to a pinned idle pause image (lifecycle-only).
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:default="registry.k8s.io/pause:3.10"
	// +optional
	Image string `json:"image,omitempty"`

	// resources are optional container resource requirements; the operator applies safe defaults when unset.
	// +optional
	Resources *corev1.ResourceRequirements `json:"resources,omitempty"`
}

// PodRef references the backing Pod. UID distinguishes a fresh runtime after resume.
type PodRef struct {
	Name string `json:"name"`
	UID  string `json:"uid"`
}

// DigitalEmployeeStatus is the observed state reported by the operator.
type DigitalEmployeeStatus struct {
	// phase is the observed runtime phase.
	// +kubebuilder:validation:Enum=Provisioning;Running;Paused;Unhealthy;Draining;Terminated
	// +optional
	Phase string `json:"phase,omitempty"`

	// observedGeneration is the .metadata.generation last reconciled into status.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// podRef references the backing Pod (name + uid). Absent when no Pod exists.
	// +optional
	PodRef *PodRef `json:"podRef,omitempty"`

	// conditions represent Ready / Progressing.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Desired",type=string,JSONPath=`.spec.desired`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// DigitalEmployee is the Schema for the digitalemployees API
type DigitalEmployee struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of DigitalEmployee
	// +required
	Spec DigitalEmployeeSpec `json:"spec"`

	// status defines the observed state of DigitalEmployee
	// +optional
	Status DigitalEmployeeStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// DigitalEmployeeList contains a list of DigitalEmployee
type DigitalEmployeeList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []DigitalEmployee `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &DigitalEmployee{}, &DigitalEmployeeList{})
		return nil
	})
}
