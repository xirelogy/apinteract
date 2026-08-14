import { readonly, ref, type DeepReadonly, type Ref } from "vue";

export type DisplayStyle = "system" | "light" | "dark";

const STORAGE_KEY = "apinteract.displayStyle";
const displayStyle = ref<DisplayStyle>(readDisplayStyle());

/** Provides the saved display style and the operation that replaces it. */
export interface DisplayStylePreference {
  readonly displayStyle: DeepReadonly<Ref<DisplayStyle>>;
  readonly setDisplayStyle: (style: DisplayStyle) => void;
}

/** Applies the saved preference before the application is mounted. */
export function initializeDisplayStyle(): void {
  applyDisplayStyle(displayStyle.value);
}

/** Exposes the browser-wide display-style preference to presentation settings. */
export function useDisplayStylePreference(): DisplayStylePreference {
  return {
    displayStyle: readonly(displayStyle),
    setDisplayStyle,
  };
}

/** Persists and immediately applies an explicit or system display style. */
function setDisplayStyle(style: DisplayStyle): void {
  displayStyle.value = style;
  applyDisplayStyle(style);
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // Browser storage can be disabled; the active document still reflects it.
  }
}

/** Selects a validated persisted style or falls back to the operating system. */
function readDisplayStyle(): DisplayStyle {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Maps System to native colour-scheme negotiation and explicit styles to CSS. */
function applyDisplayStyle(style: DisplayStyle): void {
  if (style === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = style;
  }
}
