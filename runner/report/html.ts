// Escaping shared by the report's HTML, SVG and Markdown writers.

/** Text or an attribute value for HTML/SVG: & < > " ' */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** A table cell in GitHub-flavoured Markdown: no pipes, no line breaks. */
export function escapeMdCell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');
}
