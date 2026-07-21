import { createRouter, createWebHashHistory } from "vue-router";

import { useApplicationStore } from "@/control/state/application-store";
import LoginPage from "@/view/presentation/pages/LoginPage.vue";
import MainPage from "@/view/presentation/pages/MainPage.vue";

export const router = createRouter({
  history: createWebHashHistory("/web-ui/"),
  routes: [
    { path: "/", redirect: "/main" },
    { path: "/login", component: LoginPage },
    { path: "/main", component: MainPage },
  ],
});

router.beforeEach((to) => {
  const authenticated = useApplicationStore().session !== null;
  if (!authenticated && to.path !== "/login") {
    return "/login";
  }
  if (authenticated && to.path === "/login") {
    return "/main";
  }
  return true;
});
