# Inspect response content

The response panel keeps the retained raw body preview separate from any
formatted or rendered interpretation. Use **Raw** when exact preview text and
line positions matter. Use **Download response body** when you need the full,
unchanged response bytes; a large response may exceed the preview limit even
though its complete body remains downloadable.

## Text and structured content

Textual raw previews use a read-only code viewer with line numbers. APInteract
classifies structured content from the response's declared `Content-Type`; it
does not guess an active format from body bytes.

A complete, valid JSON response receives a **JSON** tab with formatting,
syntax highlighting, line numbers, and folding. Formatting preserves source
tokens such as large number spellings and duplicate members. XML media types
receive an **XML** tab with parser-backed highlighting, line numbers, and
folding when the complete source is valid. The Raw tab remains available next
to every structured view. Invalid or truncated structured content stays in
Raw and is labelled instead of being corrected silently.

## HTML preview safety

Complete `text/html` and `application/xhtml+xml` previews can be opened in the
**Preview** tab. Response HTML is untrusted and does not run in APInteract's
document:

- active elements and URL-bearing attributes are sanitized;
- the preview runs in an iframe with an empty sandbox permission set;
- scripts, forms, navigation, popups, downloads, and same-origin access are
  unavailable; and
- a restrictive preview Content Security Policy blocks remote and local
  network resources.

Consequently, pages that depend on scripts, external styles, fonts, frames, or
images will not look identical to the live site. APInteract does not offer a
"load remote content" bypass because merely fetching a response-controlled URL
could disclose network information or contact a private service.

## Images and binary bodies

APInteract can lazily display declared PNG, JPEG, GIF, WebP, BMP, and ICO
responses. It retrieves the bytes through the authenticated response-body
operation, validates their signature and dimensions, and uses a short-lived
local object URL. The bearer credential is never placed in the image URL.

Image preview is limited to 16 MiB encoded size, 16,384 pixels per dimension,
and 40 million decoded pixels. These limits protect browser and mobile memory
from very large files and compressed-image expansion. Larger or unsupported
images remain downloadable. SVG is treated as XML source rather than rendered
as an image.

For other binary or non-previewable responses, Raw shows the declared media
type, stored byte count, and SHA-256 digest when available. This metadata and
the exact download action remain available without converting binary bytes to
misleading text.
