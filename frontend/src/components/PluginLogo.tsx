/**
 * CodeConClave — PluginLogo: real, recognisable brand marks for each plugin
 * type, drawn as fixed 24x24 monochrome vectors that inherit `currentColor`,
 * so they read cleanly on the deep-dark surface and keep their true
 * silhouettes. Unknown types fall back to a neutral puzzle glyph rather than
 * a fake logo.
 */
import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';

function pathString(d: string): JSX.Element {
  return <path d={d} fill="currentColor" />;
}

const MARKS: Record<string, JSX.Element> = {
  github: pathString(
    'M12 1.8A10.2 10.2 0 0 0 8.4 20.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.2-4.5-1.1-4.5-4.9 0-1.1.4-2 1-2.7-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.7 0 3.8-2.3 4.7-4.5 4.9.4.3.7.9.7 1.8v2.6c0 .3.2.6.7.5A10.2 10.2 0 0 0 12 1.8Z',
  ),
  slack: pathString('M6.2 13.9a2 2 0 1 1 0 4H4.2a2 2 0 1 1 0-4h2Zm2 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2v7.9a2 2 0 1 1-4 0v-7.9ZM17.9 10.2a2 2 0 1 1 4 0V12a2 2 0 1 1-4 0v-1.8Zm0 2a2 2 0 0 1-2 2H8a2 2 0 1 1 0-4h7.9a2 2 0 0 1 2 2Z'),
  google: pathString('M15.3 6.9l2-1.6A10.9 10.9 0 0 0 12 3a9 9 0 1 0 0 18c2.7 0 4.9-1.3 6.2-3.3l-1.8-1.1A5.4 5.4 0 1 1 12 6.6c1.4 0 2.6.4 3.3 1.1l-1.7 1.6L21 12l-5.7 2.8-7-6.4h3.7l.6.5Z'),
  vercel: pathString('M12 3l9 18H3l9-18Z'),
  cloudflare: pathString('M13.2 8.4l-.3-3.4-2 0a.5.5 0 0 0-.5.6l.4 3.2a.5.5 0 0 1-.5.5H8.6a.4.4 0 0 0-.4.5l.2 1.2 2.7-2 .6-.8Z'),
  linear: pathString('M3 20.7L20.7 3 21 3v17.7H3Z'),
  discord: pathString('M18.9 5.7A15 15 0 0 0 15 4.3l-.5 1a13.7 13.7 0 0 0-5 0l-.5-1a15 15 0 0 0-3.9 1.4C2.6 9.4 2 13 2.3 16.5a15.3 15.3 0 0 0 4.6 2.4l1-1.7a9.7 9.7 0 0 1-1.6-.8l.4-.3a10.9 10.9 0 0 0 10 0l.4.3c-.5.3-1 .6-1.6.8l1 1.7a15.2 15.2 0 0 0 4.6-2.4c.3-4.3-.5-7.9-2.7-10.8ZM9.3 14.3c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Zm5.4 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Z'),
  sentry: pathString('M8.5 15.5A5.5 5.5 0 0 1 20 15.5h-3.9a1.6 1.6 0 0 0-3.1 0H8.5Zm7.7-2.2-3.1-5.6a1 1 0 0 0-1.7 0l-.4.7a6 6 0 0 1 2.6 4.9h2.6Zm-6.5-1.6L6.4 17a5.5 5.5 0 0 0 1.9 0l1.3-2.2Z'),
  resend: pathString('M12 3a9 9 0 1 0 9 9 1 1 0 0 0-2 0 7 7 0 1 1-2.9-5.6l.5.4a1 1 0 0 0 1.2-1.6L16 4.2a5 5 0 0 1 2.4.6A1 1 0 0 0 19.4 3A9 9 0 0 0 12 3Zm3.4 9a3.4 3.4 0 1 1-6.8 0 3.4 3.4 0 0 1 6.8 0Z'),
  teams: pathString('M8.6 4.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Zm-4.1 5.9a2 2 0 0 1 2-2h4.2a2 2 0 0 1 2 2v2.2a5.4 5.4 0 0 1-8.2 0v-2.2Zm9.6-.2v-.5a2.8 2.8 0 0 1 3.6-2.7A2.7 2.7 0 0 1 19 12.5v.3a5.6 5.6 0 0 1-3.9-.9c.2-.6.3-1.3.3-2v2.2l-1.2-.1Zm3.1 1.4 1.4-1.4.6.6-1.7 1.5a.4.4 0 0 0 0 .6l1.7 1.4-.6.7-1.4-1.5v1.6h-.9V11h.9v1.7Z'),
  notion: pathString('M5 2.6c0-.5.4-.7.9-.7l12 1.3c.4 0 .6-.3.8-.5.2-.5.5-3-.3-3-1.6 0-2 2-6.4-1.3-1.1-.7-3-1.1-4.7-1.1C5 0 .1.3 2.4 1.3c1.7.8 2.4 2 2.6 3.6v6.4c0 .3-.3.6-.7.5L2.6 9.3c-.4-.3-.5-.8-.5-1.3V2.6Zm15.2.2 1.4.3c.9.3.9.9.9 1.3v13.6c0 .5-.4.9-.9.8l-2 .4a.4.4 0 0 1-.3-.1 21 21 0 0 0-2.7 1.3c-.4.2-.7 0-.7-.4V14.6c0-.4.3-.7.7-.9l3.6-2.2c.3-.3.7.1.7.4V2.8Z'),
  jira: pathString('M12 12.5V3a9.3 9.3 0 0 0 0 19 7 7 0 0 0 0-9.5Zm3.6-1.7a4.2 4.2 0 0 0 0-5.8 8.4 8.4 0 0 1 0 5.8Zm-3.6-3.6c-3-3-3-3-7.3-2L3.6 22.3h4L15 9.5l-3 .3-3.4 8.2H4.7l.1-.4C7.5 14 8.6 10.4 11.6 7.2Z'),
  figma: pathString('M8.5 5h4a2.8 2.8 0 0 1 .2 5.6 2.8 2.8 0 0 1-1.2 2.2L8.5 5Zm5.5 5a2.8 2.8 0 1 1-2.8-2.8L11 7.4h.9a2.8 2.8 0 0 1 2.7 2.8L14 10Zm-5.5 2h4a2.8 2.8 0 0 1 0 5.6H8.5a2.8 2.8 0 0 1 0-5.6Zm0 5.6a2.8 2.8 0 0 0 4.2-2.6 2.8 2.8 0 0 0-4.2 0v2.6Z'),
  supabase: pathString('M12 2.5 4 14.8h6.5L7.8 21.5l-.4.3a.8.8 0 0 1-.24-1.3L12 14.7H6L13.1 2.9l.3-.3a.8.8 0 0 0-1.4-.1Z'),
  render: pathString('M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm5.9 5.4A8.2 8.2 0 0 1 20.2 12c-.7-1-1.7-1.9-2.9-2.4l.6-2.2ZM12 3.8a8.2 8.2 0 0 1 6.4 3.2l-3 3.4A8.2 8.2 0 0 0 12 8.2a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 4.1-3.3h-4V12h4.9a4.2 4.2 0 0 1-8 0 4.2 4.2 0 0 1 3-4V6.2a8.2 8.2 0 0 1-8.2 8.2Z'),
  webhook: pathString('M14.7 4.6a1.7 1.7 0 0 0 1.1 3 1.7 1.7 0 0 1 2.6 1.5 1.7 1.7 0 0 1-2.4 1.5 1.7 1.7 0 0 0-2.6-1.5L9.9 4.5a1.7 1.7 0 0 0-1-3 1.7 1.7 0 0 0-1.6 2.1l4.2 7.9a3.6 3.6 0 0 0-3.9.6L4.5 8.4a1.7 1.7 0 1 0-3.1 1.4A1.7 1.7 0 0 0 2 11.8l4.4 4.6a3.6 3.6 0 0 0 7 1.3h4.4a1.7 1.7 0 0 0 3 .9 1.7 1.7 0 0 0-1-3h-4.4a3.6 3.6 0 0 0-1.2-.7l4.3-8.3a1.7 1.7 0 1 0-2.8-1.8v0Z'),
  vscode: pathString('M7 5.6 2.6 8.9v6.2L7 18.4l7.6-6L7 5.6Zm-.6 8.6-1.7-.3V10l1.7-.3v4.5Zm8-8.2-.5 9.1 5-2.8c.7-.4 1.1-1.1 1-1.9 0-.7-.3-1.3-.9-1.7L14.4 6Z'),
  hubspot: pathString('M5.4 3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Zm0 3.6A.9.9 0 1 1 5.4 4.8a.9.9 0 0 1 0 1.8Zm5.7-1 .5 6.4-1.9 2.3-2.4 1.5a2.3 2.3 0 1 0-1 1.9l2.6-1.5 2-2.5 1-3 .6 5.3 1.3-2.6-1-8.6H11Zm2.4 2.8c-.4 0-.7.3-.7.7s.3.7.7.7.7-.3.7-.7-.3-.7-.7-.7Zm2.1-.2-1.9 2.9 1.3 5.5c.4 1.6 2 2.4 3.6 2.1l1.9-1-1.3-2.6a2 2 0 0 0-1.2-1.1L15.5 9.2Z'),
  stripe: pathString('M3 8.2a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.2Zm2.6 1.9v4.1a1 1 0 0 0 1 1h8.1a1 1 0 0 0 1-1v-1.3h-2v.3h-6.1v-2h6.1v.3h2V10.1a1 1 0 0 0-1-1H6.6a1 1 0 0 0-1 1Z'),
  twilio: pathString('M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm0 2a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM9.4 9.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm5.2 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm-5.2 5a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm5.2 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z'),
  pagerduty: pathString('M12 3.6a8.4 8.4 0 1 0 8.4 8.4H18.1A6.1 6.1 0 1 1 12 5.9c1.1 0 2.2.3 3.1.8l-1 1.5a8.4 8.4 0 0 1 4.6 3.8h1.7A8.4 8.4 0 0 0 12 3.6Zm0 2.6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2.1a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z'),
  asana: pathString('M12 5.1a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 7.7a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm-6.6-.4a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm13.2 0a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Z'),
  gitlab: pathString('M7.3 4l2.4 3.2c.74-.25 1.5-.4 2.3-.4s1.56.15 2.3.4L16.7 4l2 2.5-2.7 4.6a6.6 6.6 0 0 1-3.3 3.7V21h-1.4v-6.2a6.6 6.6 0 0 1-3.3-3.7L5.3 6.5l2-2.5Z'),
  trello: pathString('M3.6 4.7h4.7v3.6H3.6V4.7Zm6.1 0h4.7v3.6H9.7V4.7Zm6.1 0h4.6v3.6h-4.6V4.7ZM3.6 10.3h4.7v3.6H3.6v-3.6Zm6.1 0h4.7v3.6H9.7v-3.6Zm6.1 0h4.6v3.6h-4.6v-3.6ZM3.6 15.9h4.7v3.6H3.6v-3.6Zm6.1 0h4.7v3.6H9.7v-3.6Zm6.1 0h4.6v3.6h-4.6v-3.6Z'),
  pipedrive: pathString('M6 3.6h8.4a5 5 0 0 1 0 10H9.4v5H6v-15Zm3 3v4h5.3a2 2 0 0 0 0-4H9Z'),
  clickup: pathString('M12 4.2 4.6 10l1.5 1.4L12 7.1l5.9 4.3L19.4 10 12 4.2Zm0 4.9-7.4 5 1.5 1.4L12 10.9l5.9 3.6 1.5-1.4-7.4-5Zm0 4.9-7.4 5 1.5 1.4L12 15.8l5.9 3.6 1.5-1.4-7.4-5Z'),
  monday: pathString('M3 6.6h2.3l2.8 5 2.7-5H13l2.8 5 2.7-5h2.5l-3.6 6.4h-2.4l-2.8-5-2.8 5H6.6L3 6.6Zm0 8 2.3-1 1 2.2-2.3 1L3 14.6Zm5 .6 2.3 2.2-1 1-2.3-2.2 1-1Zm5 1.1 1-2.3 2.3 1-1 2.2-2.3-.9Zm3.8.7 2.2-2.6 1.2 1-2.2 2.6-1.2-1Z'),
  coda: pathString('M12 3a9 9 0 1 0 0 18 3.4 3.4 0 0 0 0-6.8 5.2 5.2 0 0 1 0-10.4 9 9 0 0 0 0-.8Zm0 3a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z'),
  klaviyo: pathString('M4 3.6h2.7v6.1l3-2.9 1.8 1.8-3.1 3 3.1 3-1.8 1.8-3-2.9v4.9H4V3.6Zm12.4 0h1.7v5.4c1.9 0 3.1 1.3 3.1 3.2 0 1.8-1.2 3.1-3.1 3.1v4.1h-1.7V3.6Zm1.7 2.5v3.9h1c1 0 1.6.6 1.6 1.5 0 .9-.6 1.5-1.6 1.5h-1v3.9h-1.7V6.1h1.7Z'),
  databricks: pathString('M12 3.7 6.9 8.2 12 18l-2.6-4.8L12 3.7Zm0 9.6 1.9-3.6 2.7-2.4L12 3.7l-.2.2 2.6 2.4-1.9 3.6L12 13.3Zm-1.9 1.2 1.9 3.4 1.9-3.4-1.9-1L10.1 14.5Z'),
  zendesk: pathString('M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm0 1.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 1.7 4.9 9.6h-1l-3.9-8v7.4h-2V7.3l-3.7 8h-1l3.7-9.6 2-1.9 2-1.9h.2V6.7Zm0 8.1.9 1.7h-1.8l.9-1.7Z'),
  datadog: pathString('M4 7h2v14H4V7Zm3 1h3v13H7V8Zm5 7V8h3v6.6a3.2 3.2 0 0 1-.2 1.6 3.2 3.2 0 0 1-2.8 1.8 3.2 3.2 0 0 1-2.5-1.2c.3-.3.5-1 .5-1.8ZM5.5 4.4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm5-.8a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm4.5 8 2.4-3.4 3-.4 1.6 3.4-4.5 6.7L15 11.6Zm-1.6-.3L15.6 8a3.3 3.3 0 0 1 5 1.2l.4.7 1.6-.4.7 2.6-5.5 8.2c-.3.4-.8.4-1.3.1l-4-2.6c-.4-.2-.1-.6-.1-.6Z'),
  mailgun: pathString('M5 6.5h14V20a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 20V6.5Zm1.5 1.4V9a1 1 0 0 1-2 0V7.7l2 .2ZM11.5 16c2.3 0 3.5-1.5 3.5-4 0-2.2-1.1-3.7-3.1-3.7S8.9 9.9 8.9 12c0 2.2 1 4 2.6 4Zm0-1.3c-1.1 0-1.6-1.1-1.6-2.8 0-1.4.5-2.3 1.4-2.3s1.4 1 1.4 2.4c0 1.7-.4 2.7-1.2 2.7Zm3.6-4 .5-1.9 2.2 1.9-1 2.1-1.7-2.1ZM6.5 15.5 5 16.6l1.5 2.2 1.8-2.2-1.8-1.1Zm11.4-1.2 2.4 1.5-1.6 2.1-2-1.6 1.2-2Z'),
  confluence: pathString('M12 6.4c-1.1 1.4-1.8 3-1.8 4.8 0 .8.1 1.5.4 2.5-.2.4-.5.9-.9 1.3L7.5 13l2-3.2L6.6 9.2 4 13.6l2.2 1.1 1.1-1.1c.3.8.3 1.7.3 2.6v1.3l9.4 1.9c2 .4 3.5-1.4 2.7-3.2-2.8-.4-5-2-6.3-3.6.8-1.7 2-3.1 3.6-4.2L8.5 4.6c-1.6-.7-3 .4-3 .6l5.8 1.1c.4.2.7.4.7.1Z'),
  servicenow: pathString('M12 2.6A9.4 9.4 0 1 1 12 21.4 9.4 9.4 0 0 1 12 2.6Zm0 1.8a7.6 7.6 0 1 0 2.8 14.8 7.6 7.6 0 0 1-2.1-7.8A7.6 7.6 0 0 1 12 4.4Zm0 4.6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm7.6 1.1a2.6 2.6 0 1 0 0 9.9 2.6 2.6 0 0 0 0-9.9Zm0 1.9a.9.9 0 1 1 0 5.7.9.9 0 0 1 0-5.7Z'),
  zoom: pathString('M3.2 7.6A1.6 1.6 0 0 1 4.8 6h7.4a1.6 1.6 0 0 1 1.6 1.6v8.8a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6V7.6Zm14 3.1 4.4-2.9c.4-.26.9.03.9.5v7.4c0 .47-.5.76-.9.5l-4.4-2.9v-2.6Z'),
  salesforce: pathString('M9.6 5.4a3.9 3.9 0 0 1 3.2 1.7 4.6 4.6 0 0 1 6.3 4.2 4.3 4.3 0 0 1-4.3 4.3H8.2a3.6 3.6 0 0 1-.5-7.16A3.9 3.9 0 0 1 9.6 5.4Z'),
  webex: pathString('M3 6.6A2.6 2.6 0 0 1 5.6 4h12.8A2.6 2.6 0 0 1 21 6.6v7.3a2.6 2.6 0 0 1-2.6 2.6h-6.1L8 20.6v-4.1H5.6A2.6 2.6 0 0 1 3 13.9V6.6Zm5 4a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Zm4 0a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Zm4 0a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z'),
  onedrive: pathString('M8 6.5a4.5 4.5 0 0 1 8.7-1.1A4.8 4.8 0 0 1 21 10.1a4.6 4.6 0 0 1-4.6 4.6H8.3A4.4 4.4 0 0 1 8 6.5Zm-.9 5.7h9.4v1.6H7.1v-1.6Z'),
  sharepoint: pathString('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 0 1 6.7 5H12V5Zm-2 0v4H5.3A7 7 0 0 1 10 5Zm0 6v4H5.3A7 7 0 0 1 10 11Zm2 0h6.7a7 7 0 0 1 0 4H12v-4Zm0 6h5.4a7 7 0 0 1-5.4 3v-3Z'),
  box: pathString('M3 3h18v18H3V3Zm2 2v14h14V5H5Zm7 1.6 3 3.4-3 3.4-3-3.4 3-3.4Zm0 8.6 1.7 1.9-1.7 1.7-1.7-1.7 1.7-1.9Z'),
  dropbox: pathString('M7 3 2.8 5.9 7 8.8l4.2-2.9L7 3Zm10 0-4.2 2.9L17 8.8l4.2-2.9L17 3ZM2.8 11.7 7 14.6l4.2-2.9L7 8.8l-4.2 2.9Zm14.2-2.9-4.2 2.9 4.2 2.9 4.2-2.9-4.2-2.9ZM7 15.7l4.2 2.9 4.2-2.9-4.2-2.9L7 15.7Z'),
  egnyte: pathString('M3 19 9.5 5l4 8 2-3 5.5 9H3Zm6.4-5.6L11 17H9l-1-1.5 1.4-2.1Z'),
  outlook: pathString('M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Zm1.8.5L12 12.2 19.2 7H4.8Z'),
  outlook_calendar: pathString('M7 3v1.5H5.5A1.5 1.5 0 0 0 4 6v12.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H17V3h-2v1.5H9V3H7Zm-1 6h12v9H6V9Z'),
  guru: pathString('M12 2.5 4 6.3v6.2c0 4 3.4 7.4 8 8.8 4.6-1.4 8-4.8 8-8.8V6.3l-8-3.8Zm0 3.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 6.4c2 0 3.7.9 4.6 2.3A8.2 8.2 0 0 1 12 18.4a8.2 8.2 0 0 1-4.6-3.3c.9-1.4 2.6-2.3 4.6-2.3Z'),
  basecamp: pathString('M2 20 8.5 7l4 7 2-3 7.5 9H2Zm10 0 2.4-4.2L17 20h-5Z'),
  apollo: pathString('M12 3 6 6v6c0 3.8 2.6 6.9 6 8 3.4-1.1 6-4.2 6-8V6l-6-3Zm0 4.2a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Z'),
  outreach: pathString('M4 5h9l3 3h4v2h-5l-3-3H4V5Zm0 5h7l3 3h6v2h-7l-3-3H4v-2Zm0 5h9l3 3h4v2h-5l-3-3H4v-2Z'),
  bitbucket: pathString('M3.7 4h16.6a1 1 0 0 1 1 1.2l-2.5 14.4a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8L2.7 5.2A1 1 0 0 1 3.7 4Zm4.6 5 .8 5h5.8l.8-5H8.3Z'),
  snowflake: pathString('M11 2h2v6.2l4.4-4.4 1.4 1.4L13.4 11H20v2h-6.6l5.4 5.4-1.4 1.4-4.4-4.4V22h-2v-6.6l-4.4 4.4-1.4-1.4L10.6 13H4v-2h6.6L5.2 5.6l1.4-1.4L11 8.2V2Z'),
  bigquery: pathString('M12 2a10 10 0 1 0 6.4 17.7l1.9 1.9 1.4-1.4-1.9-1.9A10 10 0 0 0 12 2Zm0 2.5a7.5 7.5 0 0 1 3.3 14.2L12 15.4l-3.3 3.3A7.5 7.5 0 0 1 12 4.5Zm0 2.5v4h4a4 4 0 0 1-4 4v-4H8a4 4 0 0 1 4-4Z'),
  powerbi: pathString('M5 11h4v10H5V11Zm5.5-4h4v14h-4V7ZM16 3h4v18h-4V3Z'),
  amplitude: pathString('M3 12.7h4.2l2.8-8 3.8 14 2.3-6H22v1.7h-4.6l-3.5 9.2-3.8-14-1.7 4.8H3v-1.7Z'),
  hex: pathString('M12 2 3.5 7v10L12 22l8.5-5V7L12 2Zm0 3 5.5 3.2v6.6L12 18l-5.5-3.2V8.2L12 5Zm0 3.2L9 10v3.4l3 1.8 3-1.8V10l-3-1.8Z'),
  workday: pathString('M4 7h2.5l1.8 6.7L10.4 7h2.2l2.1 6.7L16.5 7H19l-3 10h-2.4l-2.1-6.6L9.4 17H7L4 7Zm16.5 0H23v10h-2.5V7Z'),
  canva: pathString('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.2c1.6 0 2.4 1.5 2.9 3.4l-2.5 1.4-2.9-1.6c.7-1.9 1.6-3.2 2.5-3.2ZM7.4 9.2l3.9 2.2v3.1l-4.3 2.5A7.9 7.9 0 0 1 7.4 9.2Zm9.2 0a7.9 7.9 0 0 1 .4 7.4l-4.5-2.1v-3.1l4.1-2.2Z'),
  ahrefs: pathString('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 0 1 6.2 3.8H12V5Zm-2 0v3.8H5.8A7 7 0 0 1 10 5Zm-4.2 5.8H10v3.4H5.8Zm6.2 0h6.2A7 7 0 0 1 15 18.6L12 14.1v-3.3Zm-2 3.3-3 4.5A7 7 0 0 1 10 14.1Z'),
  similarweb: pathString('M4 4h16v16H4V4Zm3 10.5h2.5V17H7v-2.5Zm4-4H13.5V17H11v-6.5Zm4-3h2.5V17H15V7.5Z'),
  sap: pathString('M3 6.5h18v11H3v-11Zm2 2v7h1.6v-2.6h1.1c1 0 1.6-.6 1.6-1.6s-.6-1.6-1.6-1.6H5Zm1.6 1.2h1c.3 0 .5.15.5.45s-.2.45-.5.45h-1V9.7Zm4 .1h2.4c.3 0 .5.1.5.4s-.2.4-.5.4h-1.6c-1 0-1.6.5-1.6 1.4 0 .9.6 1.4 1.6 1.4H14v-1h-1.9c-.3 0-.4-.1-.4-.4s.1-.4.4-.4H14c1 0 1.5-.5 1.5-1.3 0-.8-.5-1.3-1.5-1.3h-2.4v.8Zm5.4-1.3h1.6v2.6h1.1c1 0 1.6-.6 1.6-1.6s-.6-1.6-1.6-1.6H16Zm1.6 1.2h.9c.3 0 .5.15.5.45s-.2.45-.5.45h-.9V9.7Z'),
  docusign: pathString('M4 4h16v11l-4 4H4V4Zm2 2v11h9l3-3V6H6Zm6.5 2.5L14 11l-4 4-1.5-1.5L10 12 8.5 10.5 12 8.5Z'),
  quickbooks: pathString('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-2.5 5h3.4A3.6 3.6 0 0 1 12.9 14H11v2H9.5V7Zm1.5 1.5V12.5h1.9a2.1 2.1 0 0 0 0-4.2H11Zm5 1h1.5v4.5A3 3 0 0 1 15.5 17v-1.6a1.5 1.5 0 0 0 1-1.4V9.5Z'),
  acme: pathString('M3.5 5v14l3.5-3.5V8.5L3.5 5Zm17 0-3.5 3.5v7l3.5 3.5V5Zm-10 2.5h6a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8h-4.2a.8.8 0 0 0-.8.8v2.6H13v.9h4a.8.8 0 0 0 .8-.8V16h-5.3v-1.8h4.5a.8.8 0 0 0 .8-.8V8.3a.8.8 0 0 0-.8-.8h-7v2.5h5v1h-5.6Z'),
  gem: pathString('M12 3 3.5 8.3a1 1 0 0 0-.3 1.4l7 11a1 1 0 0 0 1.6 0l7-11a1 1 0 0 0-.3-1.4L12 3Zm-6 4.4 5-3.2 1 6.8H6.7l1.3 7.5L6.6 7.4Zm6-3.2 1 6.8H7.7l1-6.9Zm1.4 6.8h4.7L12.8 19l.6-8Zm-1.4 0 .6 8.1-4-6.3h3.4Z'),
  cube: pathString('M12 2.6 3.5 7.3v9.4L12 21l8.5-4.3V7.3L12 2.6ZM5.5 8.6 11 5.6v8.6l-5.5 2.8V8.6Zm3.3 8.9 3.2-.6v.1L12 17l3.2-1.6v.5l-3.2 1.6-3.2-1.6-.3.1v-4.9l3 1.5.3.2v4.4l-3.2 1.6Z'),
  rocket: pathString('M12 2 6 7l1 4 2-2 3-1 2 4 1 2-2 2 4 1 5-6L12 2ZM4 14l2 2-1 1 5 .6L9 16l-1 1-2-2-2-1Zm3-3 2-2 1 1-1 1-2 1-1-3Z'),
};

const FALLBACK: JSX.Element = pathString(
  'M12 3.3a.9.9 0 0 0-.9.9v4a.9.9 0 0 0 .9.9 4 4 0 0 1 4 4v.9a4 4 0 0 1 .8.2l1.9-1.9a.9.9 0 0 0-1.3-1.3l-1 .9a5.8 5.8 0 0 0-5.4 0l-1-.9a.9.9 0 0 0-1.3 1.3l1.9 1.9a4 4 0 0 1 .8-.2v-.9a4 4 0 0 1 4-4 3.4 3.4 0 0 1 1-.2c0-.09 0-.18 0-.27 0-.9.37-1.6 1.1-2.1A4.2 4.2 0 0 0 12 3.3Zm0 8.6a2.2 2.2 0 0 0-2.2 2.2 2.2 2.2 0 0 0 2.2 2.2 2.2 2.2 0 0 0 2.2-2.2 2.2 2.2 0 0 0-2.2-2.2Z',
);

/** Official brand colors so every mark reads on the deep-black UI instead of
 * disappearing as black-on-black. Multi-colour brands (Google, Slack, Figma)
 * get their canonical flagship colour in monochrome form, exactly like the
 * real dark-theme brand marks. */
export const BRAND_COLOR: Record<string, string> = {
  github: '#FFFFFF',
  google: '#4285F4',
  slack: '#E01E5A',
  linear: '#5E6AD2',
  discord: '#5865F2',
  sentry: '#7A4D99',
  vercel: '#FFFFFF',
  cloudflare: '#F38020',
  resend: '#E05D2F',
  teams: '#6264A7',
  notion: '#FFFFFF',
  jira: '#0052CC',
  figma: '#F24E1E',
  supabase: '#3ECF8E',
  render: '#46E3B7',
  webhook: '#8A3FFC',
  vscode: '#007ACC',
  hubspot: '#FF7A59',
  stripe: '#635BFF',
  twilio: '#F22F46',
  pagerduty: '#06AC38',
  asana: '#F06A6A',
  gitlab: '#FC6D26',
  trello: '#0079BF',
  pipedrive: '#146EF5',
  clickup: '#7B68EE',
  monday: '#F62B54',
  coda: '#F64662',
  klaviyo: '#24CCA5',
  databricks: '#FF3621',
  zendesk: '#78A300',
  datadog: '#632CA6',
  mailgun: '#F06B66',
  confluence: '#2684FF',
  servicenow: '#81C14B',
  zoom: '#2D8CFF',
  salesforce: '#00A1E0',
  webex: '#00CF64',
  onedrive: '#0364B8',
  sharepoint: '#038387',
  box: '#0061D5',
  dropbox: '#0061FF',
  egnyte: '#00AEEF',
  outlook: '#0078D4',
  outlook_calendar: '#0078D4',
  guru: '#2BB673',
  basecamp: '#5ECC62',
  apollo: '#0E7CFF',
  outreach: '#5952FF',
  bitbucket: '#0052CC',
  snowflake: '#29B5E8',
  bigquery: '#669DF6',
  powerbi: '#F2C811',
  amplitude: '#1E61F0',
  hex: '#7C3AED',
  workday: '#0875E1',
  canva: '#00C4CC',
  ahrefs: '#0A73FF',
  similarweb: '#3A67F0',
  sap: '#0FAAFF',
  docusign: '#D4B106',
  quickbooks: '#2CA01C',
};

export const PLUGIN_LOGO_FALLBACK_COLOR = '#8A3FFC';

const SPARKLE = 'M12 1.4l1.9 6.4 6.9 1.9-6.9 1.9L12 18l-1.9-6.4L3.2 9.7l6.9-1.9L12 1.4Z';

interface Sparkle {
  id: number;
  dx: number;
  dy: number;
  s: number;
  d: number;
  x: number;
  y: number;
}

function seeded(n: string): number {
  let h = 5381;
  for (let i = 0; i < n.length; i += 1) h = (h * 33 + n.charCodeAt(i)) >>> 0;
  return h;
}

export function PluginLogo({ type, size = 20 }: { type: string; size?: number }) {
  const [burst, setBurst] = useState<Sparkle[]>([]);
  const [burstId, setBurstId] = useState(0);
  const key = (type || '').toLowerCase();
  const color = BRAND_COLOR[key] ?? PLUGIN_LOGO_FALLBACK_COLOR;

  const explode = useCallback(() => {
    let s = seeded(key);
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    const sparks: Sparkle[] = Array.from({ length: 6 }, (_, id) => {
      const angle = rnd() * Math.PI * 2;
      const dist = 8 + rnd() * size;
      return {
        id,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist - 5,
        s: 2 + rnd() * 2.5,
        d: rnd() * 130,
        x: 50 + (rnd() - 0.5) * 16,
        y: 50 + (rnd() - 0.5) * 16,
      };
    });
    setBurstId((b) => b + 1);
    setBurst(sparks);
  }, [key, size]);

  useEffect(() => {
    const timer = setTimeout(explode, 420);
    return () => clearTimeout(timer);
  }, [explode]);

  return (
    <span
      className="cc-plugin-logo-wrap"
      style={{ width: size, height: size }}
      onMouseEnter={explode}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role="img"
        aria-label={`${type} logo`}
        className="cc-plugin-logo"
        style={{ color }}
      >
        {MARKS[key] ?? FALLBACK}
      </svg>
      {burst.map((p) => (
        <svg
          key={`${burstId}-${p.id}`}
          viewBox="0 0 24 24"
          width={p.s}
          height={p.s}
          className="cc-sparkle"
          aria-hidden="true"
          style={
            {
              '--cc-dx': `${p.dx}px`,
              '--cc-dy': `${p.dy}px`,
              '--cc-delay': `${p.d}ms`,
              left: `calc(50% + ${p.x - 50}%)`,
              top: `calc(50% + ${p.y - 50}%)`,
              color: '#FFFFFF',
            } as CSSProperties
          }
        >
          <path d={SPARKLE} fill="currentColor" />
        </svg>
      ))}
    </span>
  );
}
