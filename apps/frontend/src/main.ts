import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { applicationControllerKey } from "./app/dependencies";
import {
  createTranslationService,
  translationServiceKey,
} from "./app/i18n/translation-service";
import { initializeDisplayStyle } from "./app/preferences/display-style";
import { router } from "./app/router";
import { initializePwaRegistration } from "./app/pwa-registration";
import { ApplicationController } from "./control/application/application-controller";
import { SessionController } from "./control/session/session-controller";
import { BackendHttpClient } from "./control/transport/http-client";
import { BackendWebSocketClient } from "./control/transport/websocket-client";
import "./view/styling/index.css";

initializeDisplayStyle();

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

const translation = await createTranslationService();
app.use(translation.i18n);
app.provide(translationServiceKey, translation);

const http = new BackendHttpClient();
const webSocket = new BackendWebSocketClient();
const session = new SessionController(http, webSocket);
const controller = new ApplicationController(session, webSocket);
app.provide(applicationControllerKey, controller);

// Restore browser credentials before router guards inspect authenticated state.
// Otherwise a valid reload of /main can be redirected to /login while refresh
// cookie rotation is still in progress.
await session.restore();
app.use(router);
session.onAuthenticationLost(() => void router.replace("/login"));
session.startNetworkRecovery();
await router.isReady();
app.mount("#app");
initializePwaRegistration();
