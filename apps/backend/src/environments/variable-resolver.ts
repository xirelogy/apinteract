import type {
  ResolvedEnvironmentVariable,
  SelectedEnvironmentProfile,
} from "./environment-service.js";

export interface SecretReference {
  readonly variableId: string;
  readonly version: number;
}

export interface ResolvedVariableValue {
  readonly value: string;
  readonly secret: boolean;
  readonly effectiveKind: "value" | "secret";
  readonly secretReferences: readonly SecretReference[];
}

export interface InterpolatedValue extends ResolvedVariableValue {
  readonly referencedNames: readonly string[];
}

/** Raised when an executable field cannot resolve its variable references. */
export class VariableResolutionError extends Error {}

/** Resolves aliases lazily so unused invalid variables do not block execution. */
export class VariableResolver {
  readonly #variables: ReadonlyMap<string, ResolvedEnvironmentVariable>;

  constructor(profile: SelectedEnvironmentProfile | null) {
    this.#variables = new Map(
      (profile?.variables ?? []).map((variable) => [variable.name, variable]),
    );
  }

  /** Resolves one effective variable with cycle and missing-target detection. */
  resolve(name: string): ResolvedVariableValue {
    return this.#resolve(name, []);
  }

  /** Interpolates one executable text field and propagates secret taint. */
  interpolate(source: string): InterpolatedValue {
    let value = "";
    let cursor = 0;
    let secret = false;
    const references = new Map<string, SecretReference>();
    const names: string[] = [];
    while (cursor < source.length) {
      const opening = source.indexOf("<<", cursor);
      if (opening < 0) {
        value += source.slice(cursor);
        break;
      }
      value += source.slice(cursor, opening);
      if (source.startsWith("<<<<", opening)) {
        value += "<<";
        cursor = opening + 4;
        continue;
      }
      const closing = source.indexOf(">>", opening + 2);
      if (closing < 0) {
        value += source.slice(opening);
        break;
      }
      const name = source.slice(opening + 2, closing);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(name)) {
        throw new VariableResolutionError(
          `Invalid variable placeholder ${name}`,
        );
      }
      const resolved = this.resolve(name);
      value += resolved.value;
      secret ||= resolved.secret;
      names.push(name);
      for (const reference of resolved.secretReferences) {
        references.set(reference.variableId, reference);
      }
      cursor = closing + 2;
    }
    return {
      value,
      secret,
      effectiveKind: secret ? "secret" : "value",
      secretReferences: [...references.values()],
      referencedNames: names,
    };
  }

  /** Walks an alias chain while retaining every referenced secret version. */
  #resolve(name: string, path: readonly string[]): ResolvedVariableValue {
    if (path.includes(name)) {
      throw new VariableResolutionError(
        `Variable alias cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    const variable = this.#variables.get(name);
    if (variable === undefined) {
      throw new VariableResolutionError(`Variable ${name} is missing`);
    }
    switch (variable.kind) {
      case "unset":
        throw new VariableResolutionError(`Variable ${name} is unset`);
      case "value":
        return {
          value: variable.value ?? "",
          secret: false,
          effectiveKind: "value",
          secretReferences: [],
        };
      case "secret":
        if (variable.value === null || variable.secretVersion === null) {
          throw new VariableResolutionError(
            `Secret variable ${name} has no value`,
          );
        }
        return {
          value: variable.value,
          secret: true,
          effectiveKind: "secret",
          secretReferences: [
            {
              variableId: variable.variableId,
              version: variable.secretVersion,
            },
          ],
        };
      case "alias": {
        const target = variable.aliasTarget;
        if (target === null) {
          throw new VariableResolutionError(
            `Variable ${name} has no alias target`,
          );
        }
        return this.#resolve(target, [...path, name]);
      }
    }
  }
}
