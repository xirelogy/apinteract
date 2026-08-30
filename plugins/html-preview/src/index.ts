import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { FrontendPluginProviders } from "@apinteract/plugin-api/frontend";
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

/** Registers the host-owned sandboxed HTML response preview primitive. */
export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  context.register("response.content", {
    id: "html",
    label: {
      default: "Preview",
      translations: { "zh-CN": "预览", "zh-TW": "預覽" },
    },
    mediaTypes: ["text/html", "application/xhtml+xml"],
    isAvailable: ({ execution, previewComplete }) =>
      previewComplete && execution.bodyPreview !== undefined,
    isDefault: () => false,
    mountView: (container, view) => {
      const optionsFor = (current: typeof view) => ({
        source: current.execution.bodyPreview ?? "",
        title: localize(
          "Isolated HTML response preview",
          {
            "zh-CN": "隔离的 HTML 响应预览",
            "zh-TW": "隔離的 HTML 回應預覽",
          },
          current.locale,
        ),
      });
      const handle = view.ui.mountSandboxedDocument(
        container,
        optionsFor(view),
      );
      return {
        update(current) {
          handle.update(optionsFor(current));
        },
        destroy() {
          handle.destroy();
        },
      };
    },
  });
}
