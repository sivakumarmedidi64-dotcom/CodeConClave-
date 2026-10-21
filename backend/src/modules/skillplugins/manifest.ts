/**
 * CodeConClave — skill-plugin manifest contract.
 *
 * A plugin is a declarative bundle, modelled on Claude-style plugins:
 *  - skills:     named instruction blocks the coworker applies while enabled
 *  - commands:   slash commands that expand to a prompt template ($ARGUMENTS)
 *  - connectors: ids of existing connector adapters the plugin works best with
 *
 * Plugins are DATA ONLY. They carry no code and no hooks, so installing one
 * can never grant a capability, bypass approvals, or reach the network. Their
 * text is injected as clearly-labelled user-installed instructions that the
 * system prompt ranks below CodeConClave's own safety rules.
 */
import { z } from 'zod';

export const PLUGIN_CATEGORIES = [
  'engineering',
  'quality',
  'security',
  'docs',
  'planning',
  'research',
  'productivity',
  'team',
] as const;

const slug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single dashes only');

const commandName = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'command names are lowercase, no leading slash');

export const skillSchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().min(4).max(240),
  instructions: z.string().min(10).max(4000),
});

export const commandSchema = z.object({
  name: commandName,
  description: z.string().min(4).max(240),
  /** Prompt template; `$ARGUMENTS` is replaced with the text after the command. */
  prompt: z.string().min(10).max(4000),
});

export const manifestSchema = z.object({
  slug,
  name: z.string().min(2).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver x.y.z'),
  description: z.string().min(10).max(400),
  author: z.string().min(2).max(80),
  category: z.enum(PLUGIN_CATEGORIES),
  /** Icon name from the frontend icon set; unknown names fall back to 'puzzle'. */
  icon: z.string().min(2).max(32).regex(/^[a-z0-9-]+$/),
  skills: z.array(skillSchema).max(8).default([]),
  commands: z.array(commandSchema).max(12).default([]),
  connectors: z.array(z.string().min(2).max(40)).max(10).default([]),
}).refine((m) => m.skills.length + m.commands.length > 0, {
  message: 'a plugin must declare at least one skill or command',
});

export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginSkill = z.infer<typeof skillSchema>;
export type PluginCommand = z.infer<typeof commandSchema>;

/** Hard cap on the total skill text injected into one system prompt. */
export const MAX_INJECTED_SKILL_CHARS = 12_000;
