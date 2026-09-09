import type { components } from "@apinteract/api-contracts/backend";

export type AccessCredential = components["schemas"]["AccessCredential"];
export type BackendHealth = components["schemas"]["BackendHealth"];
export type WebBootstrapStatus = components["schemas"]["WebBootstrapStatus"];
export type WebBootstrapRequest = components["schemas"]["WebBootstrapRequest"];
export type CurrentSession = components["schemas"]["CurrentSession"];
export type WorkspaceSummary = components["schemas"]["WorkspaceSummary"];
export type RedirectPolicyOverride =
  components["schemas"]["RedirectPolicyOverride"];
export type ResolvedRedirectPolicy =
  components["schemas"]["ResolvedRedirectPolicy"];
export type CookiePolicyOverride =
  components["schemas"]["CookiePolicyOverride"];
export type ResolvedCookiePolicy =
  components["schemas"]["ResolvedCookiePolicy"];
export type CookieJarView = components["schemas"]["CookieJarView"];
export type CookieView = components["schemas"]["CookieView"];
export type CookieJarConcurrencyMode =
  components["schemas"]["CookieJarConcurrencyMode"];
type GeneratedWorkspaceView = components["schemas"]["WorkspaceView"];
export type WorkspaceView = Omit<
  GeneratedWorkspaceView,
  "redirectPolicy" | "cookiePolicy"
> & {
  /** Optional while restoring data produced before redirect preferences existed. */
  readonly redirectPolicy?: RedirectPolicyOverride;
  /** Optional while restoring data produced before cookie preferences existed. */
  readonly cookiePolicy?: CookiePolicyOverride;
};
export type UserPreferencesView = components["schemas"]["UserPreferencesView"];
export type TreeNode = components["schemas"]["TreeNode"];
export type CollectionView = components["schemas"]["CollectionView"];
export type CollectionDeleteResult =
  components["schemas"]["CollectionDeleteResult"];
export type EnvironmentSummary = components["schemas"]["EnvironmentSummary"];
export type EnvironmentListView = components["schemas"]["EnvironmentListView"];
export type EnvironmentCookieJarSource =
  components["schemas"]["EnvironmentCookieJarSource"];
export type EnvironmentView = components["schemas"]["EnvironmentView"];
export type EnvironmentVariableView =
  components["schemas"]["EnvironmentVariableView"];
export type EnvironmentVariableWrite =
  components["schemas"]["EnvironmentVariableWrite"];
export type EditableVariableScopeKind =
  components["schemas"]["EditableVariableScopeKind"];
export type VariableProfileView = components["schemas"]["VariableProfileView"];
export type VariableWrite = components["schemas"]["VariableWrite"];
export type TemporaryRequestVariableProfile =
  components["schemas"]["TemporaryRequestVariableProfile"];
export type VariablePreview = components["schemas"]["VariablePreview"];
export type VariablePreviewResult =
  components["schemas"]["VariablePreviewResult"];
export type ImportProviderId = components["schemas"]["ImportProviderId"];
export type ImportProviderManifest =
  components["schemas"]["ImportProviderManifest"];
export type ImportProvidersView = components["schemas"]["ImportProvidersView"];
export type ImportPlan = components["schemas"]["ImportPlan"];
export type ImportedRequest = components["schemas"]["ImportedRequest"];
export type ImportApplyResult = components["schemas"]["ImportApplyResult"];
export type CapturedExchangeView =
  components["schemas"]["CapturedExchangeView"];
type GeneratedRequestView = components["schemas"]["RequestView"];
export type RequestView = Omit<
  GeneratedRequestView,
  "redirectPolicy" | "cookiePolicy"
> & {
  /** Optional while restoring data produced before redirect preferences existed. */
  readonly redirectPolicy?: RedirectPolicyOverride;
  /** Optional while restoring data produced before cookie preferences existed. */
  readonly cookiePolicy?: CookiePolicyOverride;
};
export type RequestBodyDefinition =
  components["schemas"]["RequestBodyDefinition"];
export type RequestAttachment = components["schemas"]["RequestAttachment"];
export type MultipartFileField = components["schemas"]["MultipartFileField"];
export type RequestRevisionSummary =
  components["schemas"]["RequestRevisionSummary"];
type GeneratedRequestRevisionView =
  components["schemas"]["RequestRevisionView"];
export type RequestRevisionView = Omit<
  GeneratedRequestRevisionView,
  "request"
> & {
  readonly request: RequestView;
};
export type HttpMethod = components["schemas"]["HttpMethod"];
export type RequestField = components["schemas"]["RequestField"];
export type ExecutionView = components["schemas"]["ExecutionView"];
export type RequestExchangeSummary =
  components["schemas"]["RequestExchangeSummary"];
export type RequestExchangeListView =
  components["schemas"]["RequestExchangeListView"];
export type RequestExchangeView = components["schemas"]["RequestExchangeView"];
export type Problem = components["schemas"]["Problem"];
