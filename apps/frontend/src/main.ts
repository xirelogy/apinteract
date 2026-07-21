import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { applicationControllerKey } from "./app/dependencies";
import { router } from "./app/router";
import { ApplicationController } from "./control/application/application-controller";
import { SessionController } from "./control/session/session-controller";
import { BackendHttpClient } from "./control/transport/http-client";
import { BackendWebSocketClient } from "./control/transport/websocket-client";
import "./view/styling/index.css";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

const http = new BackendHttpClient();
const webSocket = new BackendWebSocketClient();
const session = new SessionController(http, webSocket);
const controller = new ApplicationController(session, webSocket);
app.provide(applicationControllerKey, controller);
app.use(router);

await session.restore();
await router.isReady();
app.mount("#app");
