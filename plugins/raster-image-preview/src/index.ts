import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { FrontendPluginProviders } from "@apinteract/plugin-api/frontend";

import { readImageDimensions } from "./image-dimensions";

/** Registers safe host rendering for supported raster image formats. */
export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  context.register("response.content", {
    id: "raster-image",
    label: {
      default: "Image",
      translations: { "zh-CN": "图像", "zh-TW": "圖片" },
    },
    mediaTypes: [
      "image/bmp",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/vnd.microsoft.icon",
      "image/webp",
      "image/x-icon",
    ],
    isAvailable: ({ execution, loadBody }) =>
      execution.bodyBlobId !== undefined &&
      execution.bodyBytes !== undefined &&
      loadBody !== undefined,
    isDefault: () => false,
    mountView: (container, view) => {
      const optionsFor = (current: typeof view) => {
        if (
          current.execution.bodyBytes === undefined ||
          current.loadBody === undefined
        ) {
          return null;
        }
        return {
          executionId: current.execution.executionId,
          mediaType: current.mediaType,
          byteLength: current.execution.bodyBytes,
          loadBody: current.loadBody,
          inspect: readImageDimensions,
        };
      };
      const initial = optionsFor(view);
      if (initial === null) {
        return { update() {}, destroy() {} };
      }
      const handle = view.ui.mountImageViewer(container, initial);
      return {
        update(current) {
          const options = optionsFor(current);
          if (options !== null) handle.update(options);
        },
        destroy() {
          handle.destroy();
        },
      };
    },
  });
}
