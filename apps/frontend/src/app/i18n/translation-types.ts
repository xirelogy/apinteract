import type { Plugin, Ref } from "vue";

import type { MessageSchema } from "@/app/i18n/messages";

export type LocaleDirection = "ltr" | "rtl";

export type DeepPartialMessages<T> = {
  readonly [Key in keyof T]?: T[Key] extends string
    ? string
    : DeepPartialMessages<T[Key]>;
};

export interface TranslationPack {
  readonly schemaVersion: 1;
  readonly locale: string;
  readonly name: string;
  readonly direction: LocaleDirection;
  readonly fallback?: string;
  readonly messages: DeepPartialMessages<MessageSchema>;
}

export interface TranslationPackDescriptor {
  readonly locale: string;
  readonly name: string;
  readonly direction: LocaleDirection;
  readonly path: string;
}

export interface TranslationManifest {
  readonly schemaVersion: 1;
  readonly packs: readonly TranslationPackDescriptor[];
}

export interface LocaleOption {
  readonly locale: string;
  readonly name: string;
  readonly direction: LocaleDirection;
}

export type LocalePreference = string;

export interface TranslationService {
  readonly i18n: Plugin;
  readonly locale: Readonly<Ref<string>>;
  readonly preference: Readonly<Ref<LocalePreference>>;
  readonly locales: Readonly<Ref<readonly LocaleOption[]>>;
  setPreference(preference: LocalePreference): Promise<void>;
}
