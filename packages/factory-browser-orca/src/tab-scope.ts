/**
 * Which Orca tabs the transport may touch.
 *
 * - The profile is the isolated "AI Content Factory" profile, never `default`,
 *   whose cookie jar carries the user's own sessions.
 * - A tab is usable when this process opened it, or when the user listed it
 *   in `FACTORY_ORCA_AUTHORIZED_PAGES` and it sits in the factory workspace
 *   and profile.
 * - Other tabs are never listed, read or driven. Orca enforces the workspace
 *   as well: a page command pinned to the factory workspace cannot reach a tab
 *   of another one.
 */

import type { OrcaCli } from "./orca-cli.js";
import { OrcaPolicyError } from "./errors.js";

export interface OrcaProfile {
  id: string;
  scope: string;
  label: string;
}

export interface OrcaTabInfo {
  browserPageId: string;
  profileId: string;
  worktreeId?: string;
  url: string;
  title: string;
}

export interface TabScopeOptions {
  worktree: string;
  profileId: string | null;
  profileLabel: string;
  authorizedPageIds: string[];
}

export class TabScope {
  private readonly cli: OrcaCli;
  private readonly opts: TabScopeOptions;
  private profile: OrcaProfile | null = null;
  private readonly owned = new Set<string>();
  private readonly verified = new Set<string>();

  constructor(cli: OrcaCli, opts: TabScopeOptions) {
    this.cli = cli;
    this.opts = opts;
  }

  get worktree(): string {
    return this.opts.worktree;
  }

  /** The isolated profile, resolved once. Refuses `default` and shared profiles. */
  async resolveProfile(): Promise<OrcaProfile> {
    if (this.profile) return this.profile;
    const { profiles } = await this.cli.run<{ profiles: OrcaProfile[] }>(["tab", "profile", "list"]);
    const match = this.opts.profileId
      ? profiles.find((p) => p.id === this.opts.profileId)
      : profiles.filter((p) => p.label === this.opts.profileLabel);
    const found = Array.isArray(match) ? match : match ? [match] : [];
    if (found.length === 0) {
      throw new OrcaPolicyError(
        `No Orca browser profile ${this.opts.profileId ?? `"${this.opts.profileLabel}"`}. ` +
          `Create it with: orca tab profile create --label "${this.opts.profileLabel}"`
      );
    }
    if (found.length > 1) {
      throw new OrcaPolicyError(
        `Several Orca profiles are labelled "${this.opts.profileLabel}". Set FACTORY_ORCA_PROFILE_ID.`
      );
    }
    const [profile] = found as [OrcaProfile];
    if (profile.id === "default" || profile.scope !== "isolated") {
      throw new OrcaPolicyError(
        `Profile ${profile.label} is not isolated. The factory transport never uses the default profile.`
      );
    }
    this.profile = profile;
    return profile;
  }

  /** Opens a tab in the factory workspace and profile, behind the user's visible tab. */
  async openTab(url = "about:blank", focus = false): Promise<string> {
    const profile = await this.resolveProfile();
    const args = ["tab", "create", "--url", url, "--worktree", this.opts.worktree, "--profile", profile.id];
    if (focus) args.push("--focus");
    const { browserPageId } = await this.cli.run<{ browserPageId: string }>(args);
    this.owned.add(browserPageId);
    // Confirm Orca put it where it was asked to before anything drives it.
    await this.verify(browserPageId);
    return browserPageId;
  }

  /** Checks an authorized or owned tab against the workspace and profile. */
  async adopt(pageId: string): Promise<OrcaTabInfo> {
    if (!this.owned.has(pageId) && !this.opts.authorizedPageIds.includes(pageId)) {
      throw new OrcaPolicyError(
        `Tab ${pageId} was not opened by the factory and is not in FACTORY_ORCA_AUTHORIZED_PAGES`
      );
    }
    return this.verify(pageId);
  }

  /** Throws unless the tab may be driven. Cheap: no Orca call after the first check. */
  assertUsable(pageId: string): void {
    if (!this.verified.has(pageId)) {
      throw new OrcaPolicyError(`Tab ${pageId} has not been checked against the factory scope`);
    }
  }

  isOwned(pageId: string): boolean {
    return this.owned.has(pageId);
  }

  async closeTab(pageId: string): Promise<void> {
    if (!this.owned.has(pageId)) return;
    try {
      await this.cli.run(["tab", "close", "--page", pageId, "--worktree", this.opts.worktree]);
    } finally {
      this.owned.delete(pageId);
      this.verified.delete(pageId);
    }
  }

  private async verify(pageId: string): Promise<OrcaTabInfo> {
    const profile = await this.resolveProfile();
    const { tab } = await this.cli.run<{ tab: OrcaTabInfo }>([
      "tab",
      "show",
      "--page",
      pageId,
      "--worktree",
      this.opts.worktree
    ]);
    if (tab.profileId !== profile.id) {
      throw new OrcaPolicyError(
        `Tab ${pageId} uses profile ${tab.profileId}, not "${profile.label}". Open it in the factory profile.`
      );
    }
    this.verified.add(pageId);
    return tab;
  }
}
