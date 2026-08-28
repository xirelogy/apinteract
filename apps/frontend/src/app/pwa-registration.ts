import { readonly, ref } from "vue";
import { registerSW } from "virtual:pwa-register";

const updateAvailableState = ref(false);
const shellAvailableOfflineState = ref(false);
let registrationStarted = false;
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

export const updateAvailable = readonly(updateAvailableState);
export const shellAvailableOffline = readonly(shellAvailableOfflineState);

/** Registers the application-shell worker once and exposes its prompt state. */
export function initializePwaRegistration(): void {
  if (registrationStarted || !("serviceWorker" in navigator)) return;
  registrationStarted = true;
  applyUpdate = registerSW({
    immediate: true,
    /** Publishes a persistent activation prompt for the waiting worker. */
    onNeedRefresh() {
      updateAvailableState.value = true;
    },
    /** Records that the public application shell has completed precaching. */
    onOfflineReady() {
      shellAvailableOfflineState.value = true;
    },
  });
}

/** Activates the waiting application shell and reloads into that version. */
export async function activatePwaUpdate(): Promise<void> {
  if (applyUpdate === null || !updateAvailableState.value) return;
  await applyUpdate(true);
}
