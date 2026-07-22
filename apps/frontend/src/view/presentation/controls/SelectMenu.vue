<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
  type CSSProperties,
} from "vue";
import { Check, ChevronDown, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

export interface SelectMenuOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly SelectMenuOption[];
    label: string;
    inputId?: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  {
    inputId: "",
    placeholder: "",
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
}>();
const { t } = useI18n();

defineSlots<{
  selected(props: { option: SelectMenuOption | null }): unknown;
  option(props: { option: SelectMenuOption; selected: boolean }): unknown;
}>();

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const popup = ref<HTMLElement | null>(null);
const open = ref(false);
const positioned = ref(false);
const activeIndex = ref(-1);
const popupStyle = ref<CSSProperties>({});
const generatedId = useId();
const popupId = `select-menu-${generatedId}`;
const selectedOption = computed(
  () =>
    props.options.find((option) => option.value === props.modelValue) ?? null,
);

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      closeMenu(false);
    }
  },
);

onMounted(() => {
  document.addEventListener("pointerdown", closeFromOutside);
  window.addEventListener("resize", repositionMenu);
  window.addEventListener("scroll", closeFromScroll, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeFromOutside);
  window.removeEventListener("resize", repositionMenu);
  window.removeEventListener("scroll", closeFromScroll, true);
});

/** Opens the option surface and focuses the requested or selected option. */
async function openMenu(preferredIndex?: number): Promise<void> {
  if (props.disabled || props.options.length === 0) {
    return;
  }
  open.value = true;
  positioned.value = false;
  activeIndex.value =
    preferredIndex ??
    selectableIndex(
      props.options.findIndex((option) => option.value === props.modelValue),
      1,
    );
  await nextTick();
  positionMenu();
  positioned.value = true;
  await nextTick();
  focusOption(activeIndex.value);
}

/** Closes the option surface and optionally restores trigger focus. */
function closeMenu(restoreFocus: boolean): void {
  if (!open.value) {
    return;
  }
  open.value = false;
  positioned.value = false;
  if (restoreFocus) {
    void nextTick(() => trigger.value?.focus());
  }
}

/** Toggles the option surface from pointer or keyboard activation. */
function toggleMenu(): void {
  if (open.value) {
    closeMenu(false);
  } else {
    void openMenu();
  }
}

/** Selects one enabled option and closes the option surface. */
function selectOption(option: SelectMenuOption): void {
  if (option.disabled === true) {
    return;
  }
  emit("update:modelValue", option.value);
  emit("change", option.value);
  closeMenu(true);
}

/** Opens the menu at an edge option when arrow keys target the trigger. */
function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const start = event.key === "ArrowDown" ? 0 : props.options.length - 1;
  void openMenu(selectableIndex(start, event.key === "ArrowDown" ? 1 : -1));
}

/** Provides listbox navigation, dismissal, and single-key typeahead. */
function handlePopupKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  if (event.key === "Tab") {
    closeMenu(false);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    focusOption(selectableIndex(activeIndex.value + direction, direction));
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const direction = event.key === "Home" ? 1 : -1;
    const start = event.key === "Home" ? 0 : props.options.length - 1;
    focusOption(selectableIndex(start, direction));
    return;
  }
  if (event.key.length === 1 && event.key.trim() !== "") {
    const match = typeaheadIndex(event.key);
    if (match !== -1) {
      event.preventDefault();
      focusOption(match);
    }
  }
}

/** Returns the next enabled option index while wrapping at list boundaries. */
function selectableIndex(start: number, direction: 1 | -1): number {
  if (props.options.length === 0) {
    return -1;
  }
  for (let offset = 0; offset < props.options.length; offset += 1) {
    const index =
      (start + offset * direction + props.options.length) %
      props.options.length;
    if (props.options[index]?.disabled !== true) {
      return index;
    }
  }
  return -1;
}

/** Finds the next enabled option beginning with one typed character. */
function typeaheadIndex(character: string): number {
  const query = character.toLocaleLowerCase();
  for (let offset = 1; offset <= props.options.length; offset += 1) {
    const index = (activeIndex.value + offset) % props.options.length;
    const option = props.options[index];
    if (
      option?.disabled !== true &&
      option?.label.toLocaleLowerCase().startsWith(query) === true
    ) {
      return index;
    }
  }
  return -1;
}

/** Focuses one rendered option and records it as the keyboard target. */
function focusOption(index: number): void {
  if (index < 0) {
    return;
  }
  activeIndex.value = index;
  popup.value
    ?.querySelector<HTMLElement>(`[data-option-index="${index}"]`)
    ?.focus();
}

/** Positions the teleported desktop menu next to its trigger and viewport. */
function positionMenu(): void {
  const triggerElement = trigger.value;
  const popupElement = popup.value;
  if (triggerElement === null || popupElement === null) {
    return;
  }
  if (usesMobilePresentation()) {
    popupStyle.value = {};
    return;
  }
  const viewportPadding = 8;
  const gap = 4;
  const triggerBox = triggerElement.getBoundingClientRect();
  const width = Math.min(
    Math.max(triggerBox.width, popupElement.offsetWidth),
    window.innerWidth - viewportPadding * 2,
  );
  const popupHeight = popupElement.offsetHeight;
  const spaceBelow =
    window.innerHeight - triggerBox.bottom - gap - viewportPadding;
  const spaceAbove = triggerBox.top - gap - viewportPadding;
  const placeAbove = popupHeight > spaceBelow && spaceAbove > spaceBelow;
  const top = placeAbove
    ? Math.max(viewportPadding, triggerBox.top - gap - popupHeight)
    : Math.min(
        triggerBox.bottom + gap,
        window.innerHeight - viewportPadding - popupHeight,
      );
  const alignedLeft =
    document.documentElement.dir === "rtl"
      ? triggerBox.right - width
      : triggerBox.left;
  const left = Math.min(
    Math.max(viewportPadding, alignedLeft),
    window.innerWidth - viewportPadding - width,
  );
  popupStyle.value = {
    top: `${Math.max(viewportPadding, top)}px`,
    left: `${left}px`,
    width: `${width}px`,
  };
}

/** Reports whether the app's explicit mobile presentation breakpoint applies. */
function usesMobilePresentation(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(width <= 47.5rem)").matches
    : window.innerWidth <= 760;
}

/** Repositions an open menu when viewport dimensions change. */
function repositionMenu(): void {
  if (open.value) {
    positionMenu();
  }
}

/** Closes the menu when pointer interaction leaves both trigger and popup. */
function closeFromOutside(event: PointerEvent): void {
  if (
    event.target instanceof Node &&
    !root.value?.contains(event.target) &&
    !popup.value?.contains(event.target)
  ) {
    closeMenu(false);
  }
}

/** Closes a desktop popup when an owning scroll container moves. */
function closeFromScroll(event: Event): void {
  if (
    open.value &&
    event.target instanceof Node &&
    !popup.value?.contains(event.target)
  ) {
    closeMenu(false);
  }
}
</script>

<template>
  <div ref="root" class="select-menu">
    <button
      :id="inputId === '' ? undefined : inputId"
      ref="trigger"
      class="select-menu-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="open ? popupId : undefined"
      :data-value="modelValue"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown="handleTriggerKeydown"
    >
      <span class="select-menu-selected">
        <slot name="selected" :option="selectedOption">
          {{ selectedOption?.label ?? placeholder }}
        </slot>
      </span>
      <ChevronDown
        class="select-menu-chevron"
        :class="{ 'is-open': open }"
        :size="16"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="popupId"
        ref="popup"
        class="select-menu-popup"
        :class="{ 'is-positioned': positioned }"
        :style="popupStyle"
        @keydown="handlePopupKeydown"
      >
        <header class="select-menu-mobile-header">
          <h2>{{ label }}</h2>
          <button
            class="icon-button"
            type="button"
            :title="t('common.actions.close')"
            :aria-label="t('common.actions.close')"
            @click="closeMenu(true)"
          >
            <X :size="18" aria-hidden="true" />
          </button>
        </header>
        <div class="select-menu-options" role="listbox" :aria-label="label">
          <button
            v-for="(option, index) in options"
            :key="option.value"
            class="select-menu-option"
            :class="{ 'is-selected': option.value === modelValue }"
            type="button"
            role="option"
            :data-option-index="index"
            :aria-selected="option.value === modelValue"
            :aria-disabled="option.disabled === true"
            :disabled="option.disabled"
            @click="selectOption(option)"
          >
            <span class="select-menu-check" aria-hidden="true">
              <Check
                v-if="option.value === modelValue"
                :size="16"
                aria-hidden="true"
              />
            </span>
            <span class="select-menu-option-content">
              <slot
                name="option"
                :option="option"
                :selected="option.value === modelValue"
              >
                {{ option.label }}
              </slot>
            </span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
