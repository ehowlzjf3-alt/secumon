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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// DomainRuntimeSpec defines the desired isolation namespace for one security domain (M3.3a).
//
// A DomainRuntime owns a per-domain tenant namespace and its isolation envelope
// (PodSecurityStandards, minimal RBAC, ResourceQuota/LimitRange, NetworkPolicy egress allowlist).
// control-plane writes domain *intent* only; the operator reconciles the infrastructure and
// gates employee Pods behind status.isolationReady (M3.2 boundary: control-plane=CR CRUD, operator=infra).
type DomainRuntimeSpec struct {
	// domain is the security domain this runtime isolates. Immutable.
	// +kubebuilder:validation:Enum=smb;dev_web;github;confluence
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="domain is immutable"
	Domain string `json:"domain"`
}

// DomainRuntimeStatus is the observed isolation state reported by the operator.
type DomainRuntimeStatus struct {
	// phase is the observed provisioning phase.
	// +kubebuilder:validation:Enum=Provisioning;Ready;Decommissioning
	// +optional
	Phase string `json:"phase,omitempty"`

	// isolationReady is true only when every isolation resource exists and is consistent.
	// control-plane must not create employee CRs for this domain until this is true.
	// +optional
	IsolationReady bool `json:"isolationReady,omitempty"`

	// namespace is the managed per-domain tenant namespace (de-domain-<domain>).
	// +optional
	Namespace string `json:"namespace,omitempty"`

	// observedGeneration is the .metadata.generation last reconciled into status.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// conditions represent Ready.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Domain",type=string,JSONPath=`.spec.domain`
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.status.namespace`
// +kubebuilder:printcolumn:name="Ready",type=boolean,JSONPath=`.status.isolationReady`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// DomainRuntime is the Schema for the per-domain isolation namespaces.
type DomainRuntime struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired isolation for a domain
	// +required
	Spec DomainRuntimeSpec `json:"spec"`

	// status defines the observed isolation state
	// +optional
	Status DomainRuntimeStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// DomainRuntimeList contains a list of DomainRuntime
type DomainRuntimeList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []DomainRuntime `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &DomainRuntime{}, &DomainRuntimeList{})
		return nil
	})
}
