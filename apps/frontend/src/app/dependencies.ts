import { inject, type InjectionKey } from "vue";

import type { ApplicationController } from "@/control/application/application-controller";

export const applicationControllerKey: InjectionKey<ApplicationController> =
  Symbol("ApplicationController");

/** Returns the application controller installed during frontend bootstrap. */
export function useApplicationController(): ApplicationController {
  const controller = inject(applicationControllerKey);
  if (controller === undefined) {
    throw new Error("ApplicationController was not provided");
  }
  return controller;
}
