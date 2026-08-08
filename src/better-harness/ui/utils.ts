/**
 * HTML Escaping utility to prevent XSS vulnerability in UI components.
 */
export function escapeHTML(str: unknown): string {
  if (str === null || str === undefined) return '';
  const stringified = String(str);
  return stringified
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
