import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { AuthProviderFrontendPluginProviders } from "@apinteract/plugin-api/frontend/authentication";

/** Registers the built-in username/password login experience. */
export function register(
  context: PluginRegistrationContext<AuthProviderFrontendPluginProviders>,
): void {
  context.register("authentication.login", {
    mount(container, { actions }) {
      const form = document.createElement("form");
      form.className = "login-form local-password-login";
      const username = field("Username", "text", "username");
      const password = field("Password", "password", "current-password");
      const error = document.createElement("p");
      error.className = "form-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      const submit = document.createElement("button");
      submit.className = "button-control primary-button login-submit";
      submit.type = "submit";
      submit.textContent = "Continue";
      form.append(username.wrapper, password.wrapper, error, submit);

      /** Submits provider evidence only through the host-owned auth action. */
      const handleSubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        submit.disabled = true;
        username.input.disabled = true;
        password.input.disabled = true;
        error.hidden = true;
        try {
          const result = await actions.begin({
            username: username.input.value,
            password: password.input.value,
          });
          password.input.value = "";
          if (result.status === "authenticated") actions.completed();
          else {
            error.textContent =
              result.status === "unavailable"
                ? "This sign-in method is temporarily unavailable."
                : "The supplied credentials could not be accepted.";
            error.hidden = false;
          }
        } catch {
          password.input.value = "";
          error.textContent = "The supplied credentials could not be accepted.";
          error.hidden = false;
        } finally {
          submit.disabled = false;
          username.input.disabled = false;
          password.input.disabled = false;
        }
      };
      /** Adapts the asynchronous submit workflow to the DOM listener contract. */
      const submitListener = (event: SubmitEvent) => void handleSubmit(event);
      form.addEventListener("submit", submitListener);
      container.replaceChildren(form);
      username.input.focus();
      return {
        destroy() {
          form.removeEventListener("submit", submitListener);
          form.remove();
        },
      };
    },
  });
}

/** Creates one accessible labeled credential input. */
function field(
  labelText: string,
  type: string,
  autocomplete: string,
): {
  readonly wrapper: HTMLLabelElement;
  readonly input: HTMLInputElement;
} {
  const wrapper = document.createElement("label");
  wrapper.className = "form-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.className = "text-input";
  input.type = type;
  input.setAttribute("autocomplete", autocomplete);
  input.required = true;
  wrapper.append(label, input);
  return { wrapper, input };
}
