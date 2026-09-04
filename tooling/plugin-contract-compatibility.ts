import type { components } from "../packages/api-contracts/src/backend.generated.js";
import type {
  ImportedHttpMethod,
  ImportedVariableWrite,
} from "../packages/plugin-api/src/backend.js";
import type {
  RequestAttachment,
  RequestBodyDefinition,
  ResponseExecution,
  VariablePreview,
} from "../packages/plugin-api/src/frontend.js";

type Extends<TCandidate, TTarget> = [TCandidate] extends [TTarget]
  ? true
  : false;
type Assert<TValue extends true> = TValue;

/** Keeps plugin request-body values interchangeable with the canonical contract. */
export type RequestBodyContractCompatibility = [
  Assert<
    Extends<
      components["schemas"]["RequestBodyDefinition"],
      RequestBodyDefinition
    >
  >,
  Assert<
    Extends<
      RequestBodyDefinition,
      components["schemas"]["RequestBodyDefinition"]
    >
  >,
];

/** Keeps plugin attachment values interchangeable with the canonical contract. */
export type RequestAttachmentContractCompatibility = [
  Assert<
    Extends<components["schemas"]["RequestAttachment"], RequestAttachment>
  >,
  Assert<
    Extends<RequestAttachment, components["schemas"]["RequestAttachment"]>
  >,
];

/** Keeps secret-safe plugin previews interchangeable with the canonical contract. */
export type VariablePreviewContractCompatibility = [
  Assert<Extends<components["schemas"]["VariablePreview"], VariablePreview>>,
  Assert<Extends<VariablePreview, components["schemas"]["VariablePreview"]>>,
];

/** Keeps import-provider methods interchangeable with the canonical contract. */
export type ImportedHttpMethodContractCompatibility = [
  Assert<Extends<components["schemas"]["HttpMethod"], ImportedHttpMethod>>,
  Assert<Extends<ImportedHttpMethod, components["schemas"]["HttpMethod"]>>,
];

/** Keeps imported variable writes interchangeable with the canonical contract. */
export type ImportedVariableWriteContractCompatibility = [
  Assert<
    Extends<components["schemas"]["VariableWrite"], ImportedVariableWrite>
  >,
  Assert<
    Extends<ImportedVariableWrite, components["schemas"]["VariableWrite"]>
  >,
];

/** Ensures a complete host execution always satisfies the narrow plugin view. */
export type ResponseExecutionContractCompatibility = Assert<
  Extends<components["schemas"]["ExecutionView"], ResponseExecution>
>;
