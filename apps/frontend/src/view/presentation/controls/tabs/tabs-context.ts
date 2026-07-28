import type { ComputedRef, InjectionKey } from "vue";

/** Shared state and identifiers owned by one tabs composite. */
export interface TabsContext {
  readonly selectedValue: ComputedRef<string>;
  readonly activationMode: "automatic" | "manual";
  readonly orientation: "horizontal" | "vertical";
  readonly baseId: string;
  /** Requests a controlled selection change from a trigger. */
  select(value: string): void;
}

/** Injection boundary used only by parts of the same tabs composite. */
export const tabsContextKey: InjectionKey<TabsContext> = Symbol("tabs-context");
