/**
 * CodeConClave Desktop — package entry.
 * Runs under an Electron runtime only. Foundation validation happens at the
 * logic level (desktop + electron module typechecked, unit tests green) without
 * requiring the Electron binary; packaging (`electron .`) is the incremental
 * runtime step.
 */
import { app } from 'electron';
import { launchDesktopApp } from '../electron/bootstrap.js';

app.whenReady().then(launchDesktopApp).catch((err) => {
  console.error('[desktop] failed to launch', err);
  app.exit(1);
});